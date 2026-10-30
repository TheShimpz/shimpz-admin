//! The Supervisor's `TypeSafe` key for the Jev intent-classification fast path (ADR-0077).
//!
//! The key is Space-owned and optional: without it, intent classification runs the LLM route as before. Only masked
//! metadata leaves through its session calls; [`resolve`] is the internal hand-off to Team's intent route.

use super::models::{self, KeyError};
use crate::{
    json::{self, Value},
    outbound,
    record::Store,
};

/// The decision provider.
pub const PROVIDER: &str = "typesafe";
/// `TypeSafe`'s authenticated model listing: 2xx for a valid key, 401 or 403 otherwise.
pub const VALIDATION: (&str, &str) = ("api.typesafe.ai", "/v1/models");

fn verified(store: &Store) -> Result<Option<String>, KeyError> {
    models::verified_secret(store.decision_credential()?.as_ref())
}

/// The configuration state, never the key.
///
/// # Errors
///
/// Returns [`KeyError`] for an invalid stored record.
pub fn status(store: &Store) -> Result<Value, KeyError> {
    let secret = verified(store)?;
    Ok(json::object(vec![
        ("provider", json::text(PROVIDER)),
        ("configured", Value::Bool(secret.is_some())),
        (
            "masked",
            secret
                .as_deref()
                .map_or(Value::Null, |secret| json::text(models::masked(secret))),
        ),
    ]))
}

/// Stores a key `TypeSafe` confirmed.
///
/// # Errors
///
/// Returns [`KeyError`].
pub async fn configure(
    store: &Store,
    client: &outbound::Client,
    api_key: &Value,
) -> Result<Value, KeyError> {
    let secret = models::canonical_api_key(api_key)?;
    let bearer = format!("Bearer {secret}");
    models::confirm_api_key(
        client,
        VALIDATION,
        &[("Authorization", bearer.as_str())],
        "TypeSafe",
    )
    .await?;
    store.set_decision_api_key(&secret)?;
    status(store)
}

/// Removes the key.
///
/// # Errors
///
/// Returns [`KeyError`].
pub fn remove(store: &Store) -> Result<Value, KeyError> {
    store.delete_decision_api_key()?;
    status(store)
}

/// The verified key for the intent-route hand-off; never exposed to the browser.
///
/// # Errors
///
/// Returns [`KeyError::Record`] for an invalid stored record.
pub fn resolve(store: &Store) -> Result<Option<String>, KeyError> {
    verified(store)
}
