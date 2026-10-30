//! Exact public event projections for chat on the session socket.

use crate::{
    chat::local::Answer,
    json::{self, Value},
};

/// The longest public error detail.
pub const MAX_PUBLIC_ERROR_CHARS: i64 = 800;
const FALLBACK: &str = "local chat request failed";

/// An error terminal of a safe status and `detail` when it is public-safe, else the generic detail.
#[must_use]
pub fn error_terminal(status: u16, detail: &str) -> Value {
    team_protocol::websocket::error_terminal(
        &json::int(i64::from(status)),
        detail,
        FALLBACK,
        MAX_PUBLIC_ERROR_CHARS,
    )
}

/// The generic error terminal of `status`.
#[must_use]
pub fn failed(status: u16) -> Value {
    error_terminal(status, FALLBACK)
}

fn projected_event(answer: &Answer, team_id: &str, allowed: &[&str]) -> Option<Value> {
    let event = answer.websocket_event(team_id)?;
    json::get_str(&event, "type")
        .is_some_and(|kind| allowed.contains(&kind))
        .then_some(event)
}

/// A turn's terminal: its done or error event, or an invalid-response error.
#[must_use]
pub fn turn_terminal(answer: &Answer, team_id: &str) -> Value {
    projected_event(answer, team_id, &["done", "error"])
        .unwrap_or_else(|| error_terminal(502, "local chat returned an invalid response"))
}

/// An Integration challenge event.
#[must_use]
pub fn integration_challenge_event(answer: &Answer, team_id: &str) -> Option<Value> {
    projected_event(answer, team_id, &["integrations-required"])
}

/// A human challenge event.
#[must_use]
pub fn human_challenge_event(answer: &Answer, team_id: &str) -> Option<Value> {
    projected_event(answer, team_id, &["human-required"])
}

/// The first challenge an answer carries and its kind (`integration` or `human`).
#[must_use]
pub fn first_challenge(answer: &Answer, team_id: &str) -> Option<(Value, &'static str)> {
    integration_challenge_event(answer, team_id)
        .map(|event| (event, "integration"))
        .or_else(|| human_challenge_event(answer, team_id).map(|event| (event, "human")))
}

/// Whether Team accepted a Stop of `team_id`'s turn; `None` when Team did not confirm either way.
#[must_use]
pub fn stop_accepted(answer: &Answer, team_id: &str) -> Option<bool> {
    if !answer.public || !answer.reply.success() || answer.reply.get_str("team_id") != Some(team_id)
    {
        return None;
    }
    match answer.reply.get("stopped") {
        Some(Value::Bool(stopped)) => Some(*stopped),
        _ => None,
    }
}
