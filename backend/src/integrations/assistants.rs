//! The Assistant Integration inventory projection and the fixed Cloudflare authorization bridge to Team.

use std::sync::LazyLock;

use team_protocol::{
    payload::ASSISTANT_VERSION_RE,
    python::{
        datetime::fromisoformat,
        regex::{Pattern, declared},
    },
    websocket::public_text,
};

use super::cloudflare;
use crate::{
    chat::payloads,
    command::log,
    fault::{Fault, Reply},
    json::{self, Value},
    session::topics::Topics,
    team::{bridge, transport::Team},
};

/// The most Integrations one Team's inventory lists.
pub const MAX_ASSISTANT_INTEGRATIONS: usize = 512;
/// The most scopes one Integration names.
pub const MAX_INTEGRATION_SCOPES: usize = 32;
static OAUTH_BINDING_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[A-Za-z0-9_-]{43}\Z"));
static OAUTH_CLAIM_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{64}\Z"));
static RFC3339_RE: LazyLock<Pattern> = LazyLock::new(|| {
    declared(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\Z")
});
const INVENTORY_FIELDS: [&str; 12] = [
    "assistant_id",
    "assistant_name",
    "assistant_version",
    "assistant_summary",
    "id",
    "provider",
    "name",
    "summary",
    "scopes",
    "status",
    "integration",
    "expires_at",
];

/// One OAuth browser binding.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn oauth_binding(value: &str) -> Result<String, Fault> {
    if OAUTH_BINDING_RE.is_full(value) {
        Ok(value.to_owned())
    } else {
        Err(Fault::team_request("OAuth browser binding is invalid"))
    }
}

fn oauth_claim(value: &str) -> Result<String, Fault> {
    if OAUTH_CLAIM_RE.is_full(value) {
        Ok(value.to_owned())
    } else {
        Err(Fault::team_request(
            "OAuth authorization response is invalid",
        ))
    }
}

/// The distinct OAuth scopes Team reports for one Assistant Integration.
///
/// # Errors
///
/// Returns `Err` for any other value.
pub fn integration_scopes(value: &Value) -> Result<Vec<String>, InvalidScopes> {
    let items = json::as_array(value)
        .filter(|items| (1..=MAX_INTEGRATION_SCOPES).contains(&items.len()))
        .ok_or(InvalidScopes)?;
    let scopes: Vec<String> = items
        .iter()
        .map(|item| {
            json::as_str(item)
                .filter(|scope| cloudflare::SCOPE_RE.is_full(scope))
                .map(str::to_owned)
                .ok_or(InvalidScopes)
        })
        .collect::<Result<_, _>>()?;
    let mut unique = scopes.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() == scopes.len() {
        Ok(scopes)
    } else {
        Err(InvalidScopes)
    }
}

/// Integration scopes outside their closed shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidScopes;

fn identity(value: &Value) -> Option<Value> {
    if *value == Value::Null {
        return Some(Value::Null);
    }
    if !json::has_exactly(value, &["id", "name", "username"]) {
        return None;
    }
    let shown = |key: &str| -> Option<Value> {
        match value.get(key)? {
            Value::Null if key != "id" => Some(Value::Null),
            item => public_text(item, 128).ok().map(json::text),
        }
    };
    Some(json::object(vec![
        ("id", shown("id")?),
        ("name", shown("name")?),
        ("username", shown("username")?),
    ]))
}

fn expiry(value: &Value) -> Option<Value> {
    if *value == Value::Null {
        return Some(Value::Null);
    }
    let text = json::as_str(value).filter(|text| text.len() <= 40 && RFC3339_RE.is_full(text))?;
    fromisoformat(text)
        .ok()
        .filter(|parsed| parsed.offset.is_some())?;
    Some(value.clone())
}

fn inventory_item(item: &Value, seen: &mut Vec<(String, String)>) -> Option<Value> {
    if !json::has_exactly(item, &INVENTORY_FIELDS) {
        return None;
    }
    let get = |key| item.get(key).unwrap_or(&Value::Null);
    let assistant_id = payloads::assistant_id(get("assistant_id")).ok()?;
    let integration_id = payloads::identifier(get("id")).ok()?;
    let key = (assistant_id.clone(), integration_id.clone());
    if seen.contains(&key) {
        return None;
    }
    seen.push(key);
    let version = get("assistant_version");
    let status = json::as_str(get("status")).filter(|status| {
        matches!(
            *status,
            "missing" | "connected" | "expired" | "reauthorization-required"
        )
    })?;
    if !ASSISTANT_VERSION_RE.is_full_value(version)
        || public_text(get("assistant_summary"), 80).is_err()
        || public_text(get("summary"), 160).is_err()
    {
        return None;
    }
    Some(json::object(vec![
        ("assistant_id", json::text(assistant_id)),
        (
            "assistant_name",
            json::text(public_text(get("assistant_name"), 80).ok()?),
        ),
        ("assistant_version", version.clone()),
        ("id", json::text(integration_id)),
        (
            "provider",
            json::text(payloads::identifier(get("provider")).ok()?),
        ),
        ("name", json::text(public_text(get("name"), 80).ok()?)),
        (
            "scopes",
            json::strings(integration_scopes(get("scopes")).ok()?),
        ),
        ("status", json::text(status)),
        ("integration", identity(get("integration"))?),
        ("expires_at", expiry(get("expires_at"))?),
    ]))
}

/// Status metadata only: provider tokens, controller generations, and English summaries stay private.
#[must_use]
pub fn project_inventory(response: Reply, team_id: &str) -> Reply {
    if !response.success() {
        return response;
    }
    let projected = (|| {
        let body = &response.body;
        if !bridge::closed_traced(body, &["team_id", "integrations"])
            || json::get_str(body, "team_id") != Some(team_id)
        {
            return None;
        }
        let raw = json::as_array(body.get("integrations")?)
            .filter(|items| items.len() <= MAX_ASSISTANT_INTEGRATIONS)?;
        let mut seen = Vec::with_capacity(raw.len());
        raw.iter()
            .map(|item| inventory_item(item, &mut seen))
            .collect::<Option<Vec<_>>>()
    })();
    if let Some(integrations) = projected {
        return Reply::ok(json::object(vec![(
            "integrations",
            Value::Array(integrations),
        )]));
    }
    log("warning", "team_integration_inventory_invalid");
    Reply::detail(502, "Assistant integration inventory is invalid.")
}

/// One Team's Assistant Integrations.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid Team id.
pub async fn list_assistant_integrations(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team
        .call(
            "GET",
            &format!("/v1/teams/{id}/assistant-integrations"),
            None,
        )
        .await?;
    Ok(project_inventory(response, &id))
}

fn project_authorization(response: Reply, mode: &str) -> Reply {
    if !response.success() {
        return response;
    }
    let url = response.get_str("authorization_url").map(str::to_owned);
    match url {
        Some(url)
            if bridge::closed_traced(&response.body, &["authorization_url"])
                && cloudflare::authorization_state(&url, mode).is_ok() =>
        {
            Reply::ok(json::object(vec![("authorization_url", json::text(url))]))
        }
        _ => {
            log("warning", "team_oauth_authorization_invalid");
            Reply::detail(502, "OAuth authorization response is invalid.")
        }
    }
}

/// What one authorization start names.
pub struct Start<'a> {
    /// The Team.
    pub team_id: &'a str,
    /// The challenge.
    pub challenge_id: &'a str,
    /// The Assistant.
    pub assistant_id: &'a Value,
    /// The Integration.
    pub integration_id: &'a Value,
    /// The callback binding.
    pub session_binding: &'a str,
    /// The callback mode.
    pub callback_mode: &'a str,
}

/// Starts one challenge's authorization with Team.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid request.
pub async fn start_authorization(team: &Team, start: &Start<'_>) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(start.team_id))?;
    let challenge = payloads::challenge_id(&json::text(start.challenge_id))?;
    let assistant = payloads::assistant_id(start.assistant_id)?;
    let integration = payloads::identifier(start.integration_id)?;
    let binding = oauth_binding(start.session_binding)?;
    if !matches!(
        start.callback_mode,
        "loopback" | "local-domain" | "out-of-band"
    ) {
        return Err(Fault::team_request("OAuth callback mode is invalid."));
    }
    let body = json::object(vec![
        ("assistant_id", json::text(assistant)),
        ("integration_id", json::text(integration)),
        ("callback_mode", json::text(start.callback_mode)),
        ("session_binding", json::text(binding)),
    ]);
    let path = format!("/v1/teams/{id}/assistant-integrations/challenges/{challenge}/authorize");
    let response = team.call("POST", &path, Some(&body)).await?;
    Ok(project_authorization(response, start.callback_mode))
}

/// Cancels one challenge's pending authorization with Team: 204 when Team answered it.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid request.
pub async fn cancel_authorization(
    team: &Team,
    team_id: &str,
    challenge_id: &str,
    session_binding: &str,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let challenge = payloads::challenge_id(&json::text(challenge_id))?;
    let binding = oauth_binding(session_binding)?;
    let path = format!("/v1/teams/{id}/assistant-integrations/challenges/{challenge}/authorize");
    let response = team
        .call(
            "DELETE",
            &path,
            Some(&json::object(vec![(
                "session_binding",
                json::text(binding),
            )])),
        )
        .await?;
    if !response.success() {
        return Ok(response);
    }
    if response.status != 200
        || !bridge::closed_traced(&response.body, &["cancelled"])
        || !matches!(response.get("cancelled"), Some(Value::Bool(_)))
    {
        log("warning", "team_oauth_cancellation_invalid");
        return Ok(Reply::detail(
            502,
            "OAuth cancellation response is invalid.",
        ));
    }
    Ok(Reply::new(204, json::empty()))
}

fn callback_body(body: &Value) -> Option<Value> {
    let fields = ["connected", "team_id", "assistant_id", "integration_id"];
    if !bridge::closed_traced(body, &fields) || body.get("connected") != Some(&Value::Bool(true)) {
        return None;
    }
    Some(json::object(vec![
        ("connected", Value::Bool(true)),
        (
            "team_id",
            json::text(payloads::team_id(body.get("team_id")?).ok()?),
        ),
        (
            "assistant_id",
            json::text(payloads::assistant_id(body.get("assistant_id")?).ok()?),
        ),
        (
            "integration_id",
            json::text(payloads::identifier(body.get("integration_id")?).ok()?),
        ),
    ]))
}

/// Completes a Cloudflare callback with Team; a connected Integration changes what its Team's pages show.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid state, claim, or binding.
pub async fn complete_callback(
    team: &Team,
    topics: &Topics,
    state: &str,
    claim: &str,
    session_binding: &str,
) -> Result<Reply, Fault> {
    let state = oauth_binding(state)?;
    let claim = oauth_claim(claim)?;
    let binding = oauth_binding(session_binding)?;
    let body = json::object(vec![
        ("state", json::text(state)),
        ("claim", json::text(claim)),
        ("session_binding", json::text(binding)),
    ]);
    let response = team
        .call("POST", "/v1/oauth/cloudflare/callback", Some(&body))
        .await?;
    if !response.success() {
        return Ok(response);
    }
    let Some(projected) = callback_body(&response.body) else {
        log("warning", "team_oauth_callback_invalid");
        return Ok(Reply::detail(502, "OAuth callback response is invalid."));
    };
    topics.team_changed(
        json::get_str(&projected, "team_id").unwrap_or_default(),
        &["integrations"],
    );
    Ok(Reply::ok(projected))
}
