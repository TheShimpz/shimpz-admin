//! Local model-provider credentials owned exclusively by the Admin backend.
//!
//! Only masked metadata is safe for the browser. [`resolve_api_key`] is the internal hand-off point for the Team turn
//! that carries a key in its private headers; it is never a route and never Team inference metadata.

use std::{sync::LazyLock, time::Duration};

use crate::{
    json::{self, Value},
    outbound,
    record::{StateError, Store},
};

/// The fewest bytes a key has.
pub const MIN_API_KEY_BYTES: usize = 16;
/// The most bytes a key has.
pub const MAX_API_KEY_BYTES: usize = 8 * 1024;
/// How long a key's validation waits for its provider.
pub const VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);

/// One chat model a person may choose.
#[derive(Clone, Debug)]
pub struct Model {
    /// The model id.
    pub id: String,
    /// Its title.
    pub title: String,
    /// Its input price in cents per million tokens.
    pub input_cents: i64,
    /// Its output price in cents per million tokens.
    pub output_cents: i64,
}

/// One provider.
#[derive(Clone, Debug)]
pub struct Provider {
    /// The provider id.
    pub id: String,
    /// Its title.
    pub title: String,
    /// Its default model.
    pub default_model: String,
    /// Its chat models.
    pub models: Vec<Model>,
    /// The host and path a key is validated against.
    pub validation: (String, String),
}

/// The providers of the pinned model catalog, in its order, each with only its chat models.
pub static PROVIDERS: LazyLock<Vec<Provider>> = LazyLock::new(|| {
    let catalog = json::parse(include_bytes!("../../model_catalog.json")).unwrap_or(Value::Null);
    json::get(&catalog, "providers")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .map(|provider| {
            let text =
                |value: &Value, key: &str| json::get_str(value, key).unwrap_or_default().to_owned();
            let validation = provider
                .get("credential_validation")
                .unwrap_or(&Value::Null);
            Provider {
                id: text(provider, "id"),
                title: text(provider, "title"),
                default_model: text(provider, "default_model"),
                models: json::get(provider, "models")
                    .and_then(json::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter(|model| matches!(model.get("chat"), Some(Value::Bool(true))))
                    .map(|model| Model {
                        id: text(model, "id"),
                        title: text(model, "title"),
                        input_cents: model
                            .get("input_usd_per_million_cents")
                            .and_then(json::as_int)
                            .unwrap_or(0),
                        output_cents: model
                            .get("output_usd_per_million_cents")
                            .and_then(json::as_int)
                            .unwrap_or(0),
                    })
                    .collect(),
                validation: (text(validation, "host"), text(validation, "path")),
            }
        })
        .collect()
});

/// Why a key or selection was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The browser's value failed the closed contract, or the provider rejected the key (400).
    Rejected(String),
    /// The provider could not safely confirm the key now (503).
    Unavailable(String),
    /// A stored record Admin did not write.
    Record,
    /// The store could not be read or written.
    Store,
}

impl From<StateError> for KeyError {
    fn from(error: StateError) -> Self {
        if error == StateError::Credential {
            Self::Record
        } else {
            Self::Store
        }
    }
}

/// Whether `provider` is a catalog provider.
#[must_use]
pub fn is_provider(provider: &str) -> bool {
    PROVIDERS.iter().any(|known| known.id == provider)
}

fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|known| known.id == id)
}

/// `str(value or "").strip().lower()` admitted only as a catalog provider.
///
/// # Errors
///
/// Returns [`KeyError::Rejected`] for any other provider.
pub fn canonical_provider(value: &Value) -> Result<String, KeyError> {
    let text = match value {
        Value::String(text) => {
            team_protocol::python::text::lower(team_protocol::python::text::strip(text))
        }
        _ => String::new(),
    };
    if is_provider(&text) {
        Ok(text)
    } else {
        Err(KeyError::Rejected("unsupported model provider".to_owned()))
    }
}

/// One chat model of `provider`.
///
/// # Errors
///
/// Returns [`KeyError::Rejected`] for a model the provider does not offer.
pub fn canonical_model(provider_id: &str, value: &Value) -> Result<String, KeyError> {
    let model = json::as_str(value).unwrap_or_default();
    match provider(provider_id) {
        Some(known) if known.models.iter().any(|candidate| candidate.id == model) => {
            Ok(model.to_owned())
        }
        Some(_) => Err(KeyError::Rejected(
            "unsupported model for provider".to_owned(),
        )),
        None => Err(KeyError::Rejected("unsupported model provider".to_owned())),
    }
}

/// A trimmed key of 16 to 8,192 printable ASCII bytes.
///
/// # Errors
///
/// Returns [`KeyError::Rejected`] for any other value.
pub fn canonical_api_key(value: &Value) -> Result<String, KeyError> {
    let Some(text) = json::as_str(value).filter(|text| text.is_ascii() && text.trim() == *text)
    else {
        return Err(KeyError::Rejected(
            "API key must be a trimmed ASCII string".to_owned(),
        ));
    };
    if !(MIN_API_KEY_BYTES..=MAX_API_KEY_BYTES).contains(&text.len())
        || !text.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(KeyError::Rejected(
            "API key must contain 16 to 8192 printable characters".to_owned(),
        ));
    }
    Ok(text.to_owned())
}

/// The only projection of a key the browser sees: its last four characters.
#[must_use]
pub fn masked(secret: &str) -> String {
    let tail: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

/// A stored record's verified key, or `None` when none is stored.
///
/// # Errors
///
/// Returns [`KeyError::Record`] for any record but exactly a canonical key and its positive verification time.
pub fn verified_secret(record: Option<&Value>) -> Result<Option<String>, KeyError> {
    let Some(record) = record else {
        return Ok(None);
    };
    let verified = record
        .get("verified_at")
        .and_then(json::as_int)
        .is_some_and(|at| at > 0);
    let key = record.get("api_key").map(canonical_api_key);
    match (
        json::has_exactly(record, &["api_key", "verified_at"]),
        verified,
        key,
    ) {
        (true, true, Some(Ok(key))) => Ok(Some(key)),
        _ => Err(KeyError::Record),
    }
}

fn records(store: &Store) -> Result<Value, KeyError> {
    let records = store.model_credentials()?;
    if json::members(&records)
        .unwrap_or_default()
        .iter()
        .any(|(name, _)| !is_provider(name))
    {
        return Err(KeyError::Record);
    }
    Ok(records)
}

/// Confirms one key against its fixed TLS endpoint: 2xx accepts it, 401 or 403 rejects it, and anything else is
/// unavailable. No response body is read.
///
/// # Errors
///
/// Returns [`KeyError`] as described.
pub async fn confirm_api_key(
    client: &outbound::Client,
    endpoint: (&str, &str),
    headers: &[(&str, &str)],
    provider_name: &str,
) -> Result<(), KeyError> {
    let status = client
        .get(endpoint.0, endpoint.1, headers, VALIDATION_TIMEOUT)
        .await
        .map(|answer| answer.status.as_u16());
    match status {
        Ok(200..=299) => Ok(()),
        Ok(401 | 403) => Err(KeyError::Rejected(format!(
            "{provider_name} rejected API key"
        ))),
        _ => Err(KeyError::Unavailable(format!(
            "{provider_name} validation is temporarily unavailable"
        ))),
    }
}

/// The providers' configuration state, never a key.
///
/// # Errors
///
/// Returns [`KeyError`] for an invalid stored record.
pub fn status(store: &Store) -> Result<Value, KeyError> {
    let records = records(store)?;
    let mut providers = Vec::with_capacity(PROVIDERS.len());
    for known in PROVIDERS.iter() {
        let secret = verified_secret(records.get(&known.id))?;
        let models = known
            .models
            .iter()
            .map(|model| {
                json::object(vec![
                    ("id", json::text(&model.id)),
                    ("title", json::text(&model.title)),
                    ("input_usd_per_million_cents", json::int(model.input_cents)),
                    (
                        "output_usd_per_million_cents",
                        json::int(model.output_cents),
                    ),
                ])
            })
            .collect();
        providers.push(json::object(vec![
            ("id", json::text(&known.id)),
            ("title", json::text(&known.title)),
            ("default_model", json::text(&known.default_model)),
            ("models", Value::Array(models)),
            ("configured", Value::Bool(secret.is_some())),
            (
                "masked",
                secret
                    .as_deref()
                    .map_or(Value::Null, |secret| json::text(masked(secret))),
            ),
        ]));
    }
    Ok(json::object(vec![("providers", Value::Array(providers))]))
}

/// Validates a key with its provider, then stores it; answers the provider's status entry.
///
/// # Errors
///
/// Returns [`KeyError`].
pub async fn configure(
    store: &Store,
    client: &outbound::Client,
    provider_value: &Value,
    api_key: &Value,
) -> Result<Value, KeyError> {
    let selected = canonical_provider(provider_value)?;
    let secret = canonical_api_key(api_key)?;
    let known = provider(&selected)
        .ok_or_else(|| KeyError::Rejected("unsupported model provider".to_owned()))?;
    let bearer = format!("Bearer {secret}");
    let headers: Vec<(&str, &str)> = if selected == "openai" {
        vec![("Authorization", bearer.as_str())]
    } else {
        vec![
            ("x-api-key", secret.as_str()),
            ("anthropic-version", "2023-06-01"),
        ]
    };
    confirm_api_key(
        client,
        (&known.validation.0, &known.validation.1),
        &headers,
        "model provider",
    )
    .await?;
    store.set_model_api_key(&selected, &secret)?;
    let status = status(store)?;
    Ok(json::get(&status, "providers")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .find(|item| json::get_str(item, "id") == Some(selected.as_str()))
        .cloned()
        .unwrap_or(Value::Null))
}

/// A verified provider key in cleartext, only for the Team turn that carries it; never to a browser.
///
/// # Errors
///
/// Returns [`KeyError`] for an unknown provider or invalid stored record.
pub fn resolve_api_key(store: &Store, provider_id: &str) -> Result<Option<String>, KeyError> {
    let selected = canonical_provider(&json::text(provider_id))?;
    verified_secret(records(store)?.get(&selected))
}
