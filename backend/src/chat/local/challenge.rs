//! The challenges a paused turn waits on, projected without any authorization material: an Integration's OAuth
//! consent gate, a human request rendered in the chat's language, and a human answer Team denied.

use team_protocol::websocket::{challenge_identity, public_text};

use super::{Answer, closed_traced_for};
use crate::{
    chat::{human, payloads},
    fault::Reply,
    integrations::assistants::integration_scopes,
    json::{self, Value},
    team::bridge,
};

/// The most Integrations one consent gate requires.
pub const MAX_INTEGRATION_REQUIREMENTS: usize = 64;
/// The most Actions one requirement names.
pub const MAX_INTEGRATION_ACTIONS: usize = 128;
/// The longest label.
pub const MAX_INTEGRATION_LABEL_CHARS: usize = 80;
/// The longest summary.
pub const MAX_INTEGRATION_SUMMARY_CHARS: usize = 160;
const CHALLENGE_FIELDS: [&str; 7] = [
    "team_id",
    "status",
    "turn_id",
    "challenge_id",
    "expires_in",
    "requirements",
    "trace_id",
];
const REQUIREMENT_FIELDS: [&str; 8] = [
    "assistant_id",
    "assistant_name",
    "integration_id",
    "provider",
    "name",
    "summary",
    "scopes",
    "actions",
];

fn label(value: Option<&Value>, maximum: usize) -> Option<Value> {
    public_text(value?, maximum).ok().map(json::text)
}

/// The distinct Action ids one requirement names; their English catalog text stays with Team.
fn actions(raw: &Value) -> Option<Vec<Value>> {
    let items =
        json::as_array(raw).filter(|items| (1..=MAX_INTEGRATION_ACTIONS).contains(&items.len()))?;
    let mut seen: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        if !json::has_exactly(item, &["id", "name", "summary"]) {
            return None;
        }
        let id = payloads::action_id(item.get("id")?).ok()?;
        if seen.contains(&id) {
            return None;
        }
        label(item.get("name"), MAX_INTEGRATION_LABEL_CHARS)?;
        label(item.get("summary"), MAX_INTEGRATION_SUMMARY_CHARS)?;
        seen.push(id);
    }
    Some(
        seen.into_iter()
            .map(|id| json::object(vec![("id", json::text(id))]))
            .collect(),
    )
}

fn requirement(raw: &Value) -> Option<Value> {
    if !json::has_exactly(raw, &REQUIREMENT_FIELDS) {
        return None;
    }
    let scopes = integration_scopes(raw.get("scopes")?).ok()?;
    let actions = actions(raw.get("actions")?)?;
    label(raw.get("summary"), MAX_INTEGRATION_SUMMARY_CHARS)?;
    Some(json::object(vec![
        (
            "assistant_id",
            json::text(payloads::assistant_id(raw.get("assistant_id")?).ok()?),
        ),
        (
            "assistant_name",
            label(raw.get("assistant_name"), MAX_INTEGRATION_LABEL_CHARS)?,
        ),
        (
            "integration_id",
            json::text(payloads::identifier(raw.get("integration_id")?).ok()?),
        ),
        (
            "provider",
            json::text(payloads::identifier(raw.get("provider")?).ok()?),
        ),
        ("name", label(raw.get("name"), MAX_INTEGRATION_LABEL_CHARS)?),
        ("scopes", json::strings(scopes)),
        ("actions", Value::Array(actions)),
    ]))
}

fn integration_body(body: &Value, team_id: &str) -> Option<Value> {
    if !json::has_exactly(body, &CHALLENGE_FIELDS)
        || json::get_str(body, "team_id") != Some(team_id)
        || json::get_str(body, "status") != Some("integrations-required")
        || !body.get("trace_id").is_some_and(bridge::is_trace_id)
    {
        return None;
    }
    let (challenge_id, turn_id) = challenge_identity(body, team_id)?;
    let expires_in = body
        .get("expires_in")
        .and_then(json::as_int)
        .filter(|expires| (1..=900).contains(expires))?;
    let raw = json::as_array(body.get("requirements")?)
        .filter(|items| (1..=MAX_INTEGRATION_REQUIREMENTS).contains(&items.len()))?;
    let requirements: Vec<Value> = raw.iter().map(requirement).collect::<Option<_>>()?;
    let mut identities: Vec<(&str, &str)> = requirements
        .iter()
        .map(|item| {
            (
                json::get_str(item, "assistant_id").unwrap_or_default(),
                json::get_str(item, "integration_id").unwrap_or_default(),
            )
        })
        .collect();
    identities.sort_unstable();
    identities.dedup();
    if identities.len() != requirements.len() {
        return None;
    }
    Some(json::object(vec![
        ("team_id", json::text(team_id)),
        ("status", json::text("integrations-required")),
        ("turn_id", json::text(turn_id)),
        ("challenge_id", json::text(challenge_id)),
        ("expires_in", json::int(expires_in)),
        ("requirements", Value::Array(requirements)),
    ]))
}

/// An OAuth consent gate, projected without any authorization material.
#[must_use]
pub fn project_integration_challenge(response: &Reply, team_id: &str) -> Answer {
    integration_body(&response.body, team_id).map_or_else(
        || Answer::code(502, "integration-challenge-response-invalid"),
        |body| Answer::public(response.status, body),
    )
}

/// A Team challenge; a human one requested in an interface language must be rendered in exactly it.
#[must_use]
pub fn project_pending_challenge(response: &Reply, team_id: &str, locale: Option<&str>) -> Answer {
    match response.get_str("status") {
        Some("integrations-required") => project_integration_challenge(response, team_id),
        Some("human-required") => match human::project(&response.body, team_id) {
            Ok(body)
                if locale.is_none_or(|locale| json::get_str(&body, "locale") == Some(locale)) =>
            {
                Answer::public(response.status, body)
            }
            _ => Answer::code(502, "human-challenge-response-invalid"),
        },
        _ => Answer::code(502, "chat-challenge-response-invalid"),
    }
}

/// Team denied a human answer: the person refused, or the authentication could not run.
#[must_use]
pub fn project_human_denial(response: &Reply, team_id: &str) -> Answer {
    if !closed_traced_for(&response.body, &["team_id", "status", "reason"], team_id)
        || response.get_str("status") != Some("human-denied")
    {
        return Answer::code(502, "human-response-invalid");
    }
    match response.get_str("reason") {
        Some("denied") => Answer::code(409, "human-request-denied"),
        Some("authentication-unavailable") => Answer::code(409, "human-authentication-unavailable"),
        _ => Answer::code(502, "human-response-invalid"),
    }
}
