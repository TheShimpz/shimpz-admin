//! The bounded Admin to Team bridge for Teams, inference, chat, Assistants, files, and the Browser view.
//!
//! Admin owns the signed browser session but never a Docker socket; Team owns runtime lifecycle and admission. Team's
//! JSON and statuses pass through so a safe 400, 404, or 409 is never flattened, while every success is admitted only
//! in its closed shape and every unchecked body becomes Admin's own error.

use std::time::Duration;

use team_protocol::payload::{self as team_contract};
use unicode_normalization::UnicodeNormalization;

use super::transport::{self, Team};
mod assistants;
mod chat;
mod files;

pub use assistants::*;
pub use chat::*;
pub use files::*;

use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
    keys::models,
    session::topics::Topics,
};

/// The largest chat turn body.
pub const MAX_CHAT_JSON_BODY_BYTES: usize = 128 * 1024;
/// A chat stream may stay silent this long while Team waits on one Brain request (its 300 s) and a little more.
pub const CHAT_STREAM_TIMEOUT: Duration = Duration::from_secs(330);
/// A capability plan's timeout.
pub const CAPABILITY_PLAN_TIMEOUT: Duration = Duration::from_secs(65);
/// An intent route's timeout.
pub const INTENT_ROUTE_TIMEOUT: Duration = Duration::from_secs(25);
/// An Assistant install's timeout.
pub const ASSISTANT_INSTALL_TIMEOUT: Duration = Duration::from_secs(360);
/// The most Teams a Space lists.
pub const MAX_TEAMS: usize = 128;
/// The longest retry delay a busy preview or download names.
pub const MAX_PREVIEW_RETRY_MS: i64 = 2000;
/// The topic a page showing the Space's chat limit hears a change on (ADR-0119).
pub const CHAT_LIMIT_TOPIC: &str = "space/chat-limit";

/// One Team of the inventory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeamEntry {
    /// Its id.
    pub team_id: String,
    /// Its display name.
    pub team_name: String,
}

fn invalid(detail: &str) -> Reply {
    Reply::detail(502, detail)
}

/// Whether `body` is Team's closed envelope of exactly `fields` plus its trace id.
#[must_use]
pub fn closed_traced(body: &Value, fields: &[&str]) -> bool {
    let mut expected: Vec<&str> = fields.to_vec();
    expected.push("trace_id");
    json::has_exactly(body, &expected) && body.get("trace_id").is_some_and(is_trace_id)
}

/// One Team trace id.
#[must_use]
pub fn is_trace_id(value: &Value) -> bool {
    team_protocol::websocket::HEX_ID_RE.is_full_value(value)
}

/// `fields` plus Team's optional trace id, refusing an invalid one.
#[must_use]
pub fn trace_envelope(body: &Value, fields: &[&str]) -> Option<Vec<String>> {
    let mut expected: Vec<String> = fields.iter().map(|field| (*field).to_owned()).collect();
    if let Some(trace) = body.get("trace_id") {
        if !is_trace_id(trace) {
            return None;
        }
        expected.push("trace_id".to_owned());
    }
    Some(expected)
}

/// Whether `body` holds exactly `fields` plus an optional valid trace id.
#[must_use]
pub fn traced_exactly(body: &Value, fields: &[&str]) -> bool {
    trace_envelope(body, fields).is_some_and(|expected| {
        let names: Vec<&str> = expected.iter().map(String::as_str).collect();
        json::has_exactly(body, &names)
    })
}

/// `to_team_id`: a Team name as the Docker- and Postgres-safe id Team uses.
#[must_use]
pub fn to_team_id(team_name: &str) -> String {
    let expanded: String = team_protocol::python::text::casefold(team_name)
        .chars()
        .map(|character| match character {
            'æ' => "ae".to_owned(),
            'đ' | 'ð' => "d".to_owned(),
            'ı' => "i".to_owned(),
            'ł' => "l".to_owned(),
            'ø' => "o".to_owned(),
            'œ' => "oe".to_owned(),
            'þ' => "th".to_owned(),
            other => other.to_string(),
        })
        .collect();
    let ascii: String = expanded.nfkd().filter(char::is_ascii).collect();
    let mut id = String::new();
    let mut pending_separator = false;
    for character in ascii.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            if pending_separator {
                id.push('_');
                pending_separator = false;
            }
            id.push(character);
        } else {
            pending_separator = true;
        }
    }
    if pending_separator && !id.is_empty() {
        id.push('_');
    }
    let trimmed = id.trim_matches('_');
    trimmed.chars().take(40).collect()
}

/// A Local Team display name exactly as Team admits it: trimmed, bounded, NFC (ADR-0088).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other name.
pub fn local_team_name(value: &Value) -> Result<String, Fault> {
    team_contract::canonical_local_team_name(value)
        .map(str::to_owned)
        .ok_or_else(|| Fault::team_request("team name must contain 1 to 80 trimmed characters"))
}

/// One canonical source digest.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn source_digest(value: &Value) -> Result<String, Fault> {
    team_contract::canonical_source_digest(value)
        .map(str::to_owned)
        .ok_or_else(|| Fault::team_request("source digest must be a canonical sha256 digest"))
}

/// The Space's Teams as Team lists them.
pub async fn list_teams(team: &Team) -> Reply {
    team.call("GET", "/v1/teams", None)
        .await
        .unwrap_or_else(|_| transport::unavailable())
}

/// Deletes the Space, admitting only Team's exact success.
pub async fn reset_space(team: &Team) -> Reply {
    let response = team
        .call("DELETE", "/v1/space", None)
        .await
        .unwrap_or_else(|_| transport::unavailable());
    if !response.success() {
        return response;
    }
    if response.get("reset") != Some(&Value::Bool(true)) {
        return invalid("Team returned an invalid Space reset response");
    }
    Reply::ok(json::object(vec![("reset", Value::Bool(true))]))
}

/// Deletes a Space with no Supervisor yet, through Team's bootstrap path.
pub async fn bootstrap_reset_space(team: &Team) -> Reply {
    let unavailable = |status| {
        Reply::new(
            status,
            json::object(vec![
                ("code", json::text("bootstrap-reset-unavailable")),
                (
                    "detail",
                    json::text("The bootstrap Space reset did not complete; re-run shimpz reset"),
                ),
            ]),
        )
    };
    let response = team
        .call("DELETE", "/v1/space/bootstrap", None)
        .await
        .unwrap_or_else(|_| transport::unavailable());
    if response.status == 409 {
        return Reply::new(
            409,
            json::object(vec![
                ("code", json::text("bootstrap-reset-refused")),
                (
                    "detail",
                    json::text(
                        "Supervisor identity exists but Admin is not initialized; nothing was deleted",
                    ),
                ),
            ]),
        );
    }
    if !response.success() {
        return unavailable(if response.status == 503 { 503 } else { 502 });
    }
    if response.get("reset") != Some(&Value::Bool(true)) {
        return unavailable(502);
    }
    Reply::ok(json::object(vec![("reset", Value::Bool(true))]))
}

/// Creates a Local Team under a display name exactly as Team admits it.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or name.
pub async fn create(team: &Team, team_id: &str, team_name: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let name = local_team_name(&json::text(team_name))?;
    team.call(
        "POST",
        &format!("/v1/teams/{id}/create"),
        Some(&json::object(vec![("team_name", json::text(name))])),
    )
    .await
}

/// The strict Team inventory in Team's order, or the failure that stands in for it.
///
/// # Errors
///
/// Returns Team's failure, or Admin's 502 for an invalid inventory.
pub fn team_inventory(response: &Reply) -> Result<Vec<TeamEntry>, Reply> {
    if !response.success() {
        return Err(response.clone());
    }
    let refused = || invalid("Team inventory response is invalid.");
    if !traced_exactly(&response.body, &["teams"]) {
        return Err(refused());
    }
    let items = response
        .get("teams")
        .and_then(json::as_array)
        .filter(|items| items.len() <= MAX_TEAMS)
        .ok_or_else(refused)?;
    let mut teams: Vec<TeamEntry> = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .get("team_id")
            .and_then(|id| team_protocol::identifiers::canonical_team_id(id));
        let name = item
            .get("team_name")
            .and_then(|name| team_contract::canonical_team_name(name));
        match (
            json::has_exactly(item, &["team_id", "team_name", "status"]),
            id,
            name,
        ) {
            (true, Some(id), Some(name))
                if json::get_str(item, "status") == Some("running")
                    && !teams.iter().any(|known| known.team_id == id) =>
            {
                teams.push(TeamEntry {
                    team_id: id.to_owned(),
                    team_name: name.to_owned(),
                });
            }
            _ => return Err(refused()),
        }
    }
    Ok(teams)
}

/// The inventory as the browser lists it.
#[must_use]
pub fn inventory_value(teams: &[TeamEntry]) -> Value {
    Value::Array(
        teams
            .iter()
            .map(|entry| {
                json::object(vec![
                    ("team_id", json::text(&entry.team_id)),
                    ("team_name", json::text(&entry.team_name)),
                    ("status", json::text("running")),
                ])
            })
            .collect(),
    )
}

/// One current Team name from the strict inventory, or the failure that stands in for it (404 when absent).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn resolve_team_name(team: &Team, team_id: &str) -> Result<Result<String, Reply>, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = list_teams(team).await;
    Ok(team_inventory(&response).and_then(|teams| {
        teams
            .into_iter()
            .find(|entry| entry.team_id == id)
            .map(|entry| entry.team_name)
            .ok_or_else(|| Reply::detail(404, "Team not found"))
    }))
}

/// Deletes a Local Team; Team confirms its current name before any side effect.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or name.
pub async fn destroy_confirmed(
    team: &Team,
    team_id: &str,
    expected_name: &str,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let name = local_team_name(&json::text(expected_name))?;
    team.call(
        "DELETE",
        &format!("/v1/teams/{id}"),
        Some(&json::object(vec![("team_name", json::text(name))])),
    )
    .await
}

/// Renames a Local Team; only its display name changes.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or name.
pub async fn rename(team: &Team, team_id: &str, team_name: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let name = local_team_name(&json::text(team_name))?;
    let response = team
        .call(
            "PATCH",
            &format!("/v1/teams/{id}"),
            Some(&json::object(vec![("team_name", json::text(&name))])),
        )
        .await?;
    if !response.success() {
        return Ok(response);
    }
    if !traced_exactly(&response.body, &["team_id", "team_name"])
        || response.get_str("team_id") != Some(id.as_str())
        || response.get_str("team_name") != Some(name.as_str())
    {
        return Ok(invalid("Team rename response is invalid."));
    }
    Ok(Reply::new(
        response.status,
        json::object(vec![
            ("team_id", json::text(id)),
            ("team_name", json::text(name)),
        ]),
    ))
}

fn project_inference(response: Reply, team_id: &str, expected: Option<(&str, &str)>) -> Reply {
    if !response.success() {
        return response;
    }
    let body = &response.body;
    let provider = body.get("provider").map(models::canonical_provider);
    let admitted = (|| {
        if !json::has_exactly(body, &["team_id", "provider", "model", "trace_id"])
            || response.get_str("team_id") != Some(team_id)
            || !body.get("trace_id").is_some_and(is_trace_id)
        {
            return None;
        }
        let provider = provider?.ok()?;
        if response.get_str("provider") != Some(provider.as_str()) {
            return None;
        }
        let model =
            models::canonical_model(&provider, body.get("model").unwrap_or(&Value::Null)).ok()?;
        if expected.is_some_and(|(want_provider, want_model)| {
            (want_provider, want_model) != (provider.as_str(), model.as_str())
        }) {
            return None;
        }
        Some((provider, model))
    })();
    match admitted {
        Some((provider, model)) => Reply::new(
            response.status,
            json::object(vec![
                ("team_id", json::text(team_id)),
                ("provider", json::text(provider)),
                ("model", json::text(model)),
            ]),
        ),
        None => invalid("Team inference response is invalid."),
    }
}

/// The Team's provider and model selection; the controller's answer never carries a key.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn get_inference(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team
        .call("GET", &format!("/v1/teams/{id}/inference"), None)
        .await?;
    Ok(project_inference(response, &id, None))
}

/// Saves the closed, secret-free inference selection; a committed change raises the Team's `inference` topic.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or selection.
pub async fn configure_inference(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    if !json::has_exactly(payload, &["provider", "model"]) {
        return Err(Fault::team_request(
            "inference requires only provider and model",
        ));
    }
    let raw_provider = payload.get("provider").unwrap_or(&Value::Null);
    let provider = models::canonical_provider(raw_provider).map_err(key_refusal)?;
    let model = models::canonical_model(&provider, payload.get("model").unwrap_or(&Value::Null))
        .map_err(key_refusal)?;
    if json::as_str(raw_provider) != Some(provider.as_str()) {
        return Err(Fault::team_request("model provider must be canonical"));
    }
    let response = team
        .call(
            "PUT",
            &format!("/v1/teams/{id}/inference"),
            Some(&json::object(vec![
                ("provider", json::text(&provider)),
                ("model", json::text(&model)),
            ])),
        )
        .await?;
    let projected = project_inference(response, &id, Some((&provider, &model)));
    Ok(changed(projected, topics, &id, &["inference"], false))
}

fn key_refusal(error: models::KeyError) -> Fault {
    match error {
        models::KeyError::Rejected(reason) | models::KeyError::Unavailable(reason) => {
            Fault::team_request(reason)
        }
        models::KeyError::Record => Fault::CredentialRecord,
        models::KeyError::Store => Fault::Internal,
    }
}

/// A change Admin made through Team raises the topics it changed for the session sockets that show them.
#[must_use]
pub fn changed(
    response: Reply,
    topics: &Topics,
    team_id: &str,
    names: &[&str],
    registry: bool,
) -> Reply {
    if response.success() {
        topics.team_changed(team_id, names);
        if registry {
            topics.changed("assistants/registry");
        }
    }
    response
}
