//! Secret-safe Local Team chat orchestration: the browser contract is always `message/files/assistant_ids`, the model
//! key travels only in Team's private headers, and every controller answer is reprojected onto a closed public shape
//! so a buggy controller can never echo a key or internal execution details back to the browser.

pub mod challenge;
pub mod fields;
pub mod progress;
pub mod route;
pub mod turn;

use std::sync::Arc;

use team_protocol::cause::{Cause, canonical_cause, render_cause};

pub use fields::{BROWSER_FIELD, ROUTINE_FIELDS, admit_routine_fields};
pub use progress::{MAX_PUBLIC_PROGRESS_EVENTS, canonical_public_progress};

use crate::{
    fault::{Fault, Reply},
    json::{self, Value},
    process::app::App,
    space::keys::models::{self, KeyError},
    team::{
        bridge::{self, Credential},
        transport::Team,
    },
};

/// A Team answer as chat sees it: projected onto its closed public shape, or one Admin made without such a projection
/// (a failed call), which no page is ever shown as it is.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    /// The status and body.
    pub reply: Reply,
    /// Whether the body is a public projection.
    pub public: bool,
}

/// The closed error codes a page is shown, each with its words; any other code is shown as `chat-request-failed`.
const CHAT_ERROR_DETAILS: [(&str, &str); 38] = [
    (
        "assistant-rpc-failed",
        "the Assistant Action did not complete; whether it took effect is unknown",
    ),
    ("assistant-action-failed", "the Assistant Action failed"),
    (
        "action-not-declared",
        "the Assistant does not declare the requested Action",
    ),
    (
        "assistant-integration-unavailable",
        "an Assistant integration is unavailable",
    ),
    (
        "action-file-unavailable",
        "the attached file is unavailable for this Action; attach it again",
    ),
    (
        "assistant-file-busy",
        "another file-bearing Action is still running; retry",
    ),
    ("docker-unavailable", "Docker is unavailable"),
    (
        "assistant-action-blocked",
        "Assistant Action execution is blocked until it is reinstalled",
    ),
    (
        "assistant-language-drift",
        "an installed Assistant's language pack changed; retry the message",
    ),
    (
        "assistant-integration-challenge-expired",
        "the Assistant integration expired; retry the message",
    ),
    (
        "assistant-integration-contract-invalid",
        "the Assistant integration contract changed; retry the message",
    ),
    (
        "assistant-integration-state-unavailable",
        "Assistant integration state is unavailable",
    ),
    (
        "assistant-registry-drift",
        "an installed Assistant is no longer available",
    ),
    (
        "assistant-stored-input-rejected",
        "the Assistant rejected its saved input; retry the task to provide a new value",
    ),
    (
        "assistant-stored-input-state-unavailable",
        "the Team could not save or read an Assistant's saved input",
    ),
    (
        "assistant-unavailable",
        "the Brain requested an unavailable Assistant",
    ),
    (
        "brain-runtime-failed",
        "the Brain runtime could not complete the Team turn",
    ),
    ("chat-active", "this Team already has an active chat turn"),
    ("chat-request-failed", "the local chat request failed"),
    (
        "chat-response-invalid",
        "the local chat returned an invalid response",
    ),
    (
        "chat-stop-response-invalid",
        "the local chat stop response was invalid",
    ),
    ("chat-stopped", "the chat turn was stopped"),
    ("file-not-found", "a selected file was not found"),
    (
        "inference-not-configured",
        "the Team model provider is not configured",
    ),
    (
        "inference-provider-mismatch",
        "the configured model provider changed; retry",
    ),
    ("invalid-files", "the selected files are invalid"),
    (
        "invalid-action-input",
        "an Assistant Action received invalid input",
    ),
    (
        "model-credential-missing",
        "the selected model provider needs an API key",
    ),
    (
        "credential-record-invalid",
        "a stored key record is invalid; reset the Space with shimpz reset",
    ),
    (
        "ownership-conflict",
        "the Team resource ownership check failed",
    ),
    (
        "action-state-unavailable",
        "Team Action execution state is unavailable",
    ),
    (
        "runtime-unavailable",
        "the local chat runtime is unavailable; update this Shimpz Space",
    ),
    (
        "space-resetting",
        "the Space is being reset; retry when it finishes",
    ),
    (
        "integration-challenge-response-invalid",
        "the Assistant integration challenge was invalid",
    ),
    (
        "human-challenge-response-invalid",
        "the Assistant request for your input was invalid",
    ),
    (
        "human-request-invalid",
        "the Assistant request for your input changed; retry the message",
    ),
    (
        "chat-challenge-response-invalid",
        "the Assistant challenge was invalid",
    ),
    (
        "team-context-changed",
        "the Team capabilities changed; retry",
    ),
];
const CHAT_ERROR_FALLBACKS: [(u16, &str); 4] = [
    (400, "invalid chat request"),
    (409, "chat turn could not start"),
    (429, "local chat capacity reached"),
    (503, "local chat runtime is unavailable"),
];
/// A public error code.
static ERROR_CODE_RE: std::sync::LazyLock<team_protocol::python::regex::Pattern> =
    std::sync::LazyLock::new(|| {
        team_protocol::python::regex::declared(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z")
    });
/// The statuses that say Team runs no chat runtime at all.
const MISSING_RUNTIME_STATUSES: [u16; 3] = [404, 405, 501];

impl Answer {
    /// A projected answer.
    #[must_use]
    pub const fn public(status: u16, body: Value) -> Self {
        Self {
            reply: Reply::new(status, body),
            public: true,
        }
    }

    /// An answer Admin made without a projection.
    #[must_use]
    pub const fn raw(status: u16, body: Value) -> Self {
        Self {
            reply: Reply::new(status, body),
            public: false,
        }
    }

    /// A projected answer of only `{"code": code}`.
    #[must_use]
    pub fn code(status: u16, code: &str) -> Self {
        Self::public(status, json::code(code))
    }

    /// The page's error event: `<code> · <cause> · <words>`, the stable code and Team's closed cause first so a
    /// shortened copy keeps them, the cause `cause unknown` when Team stated none. Only a code of the closed table is
    /// shown with its words; any other is `chat-request-failed` with its status's words, so no text a controller made
    /// up reaches a page.
    fn error_event(&self) -> Value {
        let status = if (400..=599).contains(&self.reply.status) {
            self.reply.status
        } else {
            502
        };
        let known = self
            .reply
            .get_str("code")
            .and_then(|code| CHAT_ERROR_DETAILS.iter().find(|(name, _)| *name == code));
        let (code, words) = known.copied().unwrap_or_else(|| {
            let words = CHAT_ERROR_FALLBACKS
                .iter()
                .find(|(fallback, _)| *fallback == status)
                .map_or("local chat request failed", |(_, words)| words);
            ("chat-request-failed", words)
        });
        let cause = self.reply.get("cause").and_then(Cause::from_value);
        let detail = format!("{code} · {} · {words}", render_cause(cause.as_ref()));
        json::object(vec![
            ("type", json::text("error")),
            ("status", json::int(i64::from(status))),
            ("detail", json::text(detail)),
        ])
    }

    /// The `shimpz.chat.v7` event this projected answer is for `team_id`, if it is one.
    #[must_use]
    pub fn websocket_event(&self, team_id: &str) -> Option<Value> {
        if !self.public {
            return None;
        }
        let body = &self.reply.body;
        if let Some(challenge @ ("human-required" | "integrations-required")) =
            self.reply.get_str("status")
        {
            if self.reply.get_str("team_id") != Some(team_id) {
                return None;
            }
            let mut members = vec![("type".to_owned(), json::text(challenge))];
            members.extend(
                json::members(body)
                    .unwrap_or_default()
                    .iter()
                    .filter(|(name, _)| !matches!(name.as_str(), "team_id" | "status" | "turn_id"))
                    .cloned(),
            );
            return Some(Value::Object(members));
        }
        if !self.reply.success() {
            return Some(self.error_event());
        }
        if self.reply.get_str("team_id") != Some(team_id) {
            return None;
        }
        let mut required: Vec<&str> = json::members(body)
            .unwrap_or_default()
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| !fields::OPTIONAL_DONE_FIELDS.contains(name))
            .collect();
        required.sort_unstable();
        if required != ["clarification", "reply", "team_id", "team_name"] {
            return None;
        }
        let mut members = vec![("type".to_owned(), json::text("done"))];
        members.extend(json::members(body).unwrap_or_default().iter().cloned());
        Some(Value::Object(members))
    }
}

fn unavailable() -> Answer {
    Answer::code(503, "runtime-unavailable")
}

/// One authenticated controller failure reduced to a bounded, non-secret machine code and, when Team stated one,
/// its closed cause in canonical form; anything else Team sent, a cause outside the closed vocabulary included, is
/// dropped.
fn safe_error(response: &Reply) -> Answer {
    let code = response
        .get_str("code")
        .filter(|code| code.len() <= 80 && ERROR_CODE_RE.is_full(code))
        .unwrap_or("chat-request-failed");
    let mut body = json::code(code);
    if let Some(cause) = response.get("cause").and_then(canonical_cause) {
        json::set(&mut body, "cause", cause);
    }
    Answer::public(response.status, body)
}

/// A stored key record Admin did not write refuses the turn; its public words name the reset remedy.
fn credential_record_invalid() -> Answer {
    Answer::code(502, "credential-record-invalid")
}

/// The Team's admitted provider and the Supervisor's key for it, or the projected refusal.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn model_credential(
    app: &App,
    team: &Team,
    team_id: &str,
) -> Result<Result<Credential, Answer>, Fault> {
    let response = bridge::get_inference(team, team_id).await?;
    if MISSING_RUNTIME_STATUSES.contains(&response.status) {
        return Ok(Err(unavailable()));
    }
    if !response.success() {
        return Ok(Err(safe_error(&response)));
    }
    let provider = response.get_str("provider").unwrap_or_default().to_owned();
    match models::resolve_api_key(&app.store, &provider) {
        Ok(Some(api_key)) => Ok(Ok(Credential {
            provider,
            api_key: zeroize::Zeroizing::new(api_key),
        })),
        Ok(None) => Ok(Err(Answer::code(409, "model-credential-missing"))),
        Err(KeyError::Record) => Ok(Err(credential_record_invalid())),
        Err(_) => Err(Fault::Internal),
    }
}

/// The routing and planning objective Team admits; anything not text is left for Team to refuse.
fn routable(objective: &Value) -> Value {
    json::as_str(objective).map_or_else(
        || objective.clone(),
        |text| json::text(crate::history::context::routable_text(text)),
    )
}

/// Whether `body` is Team's closed traced envelope of `fields` for `team_id`.
fn closed_traced_for(body: &Value, fields: &[&str], team_id: &str) -> bool {
    bridge::closed_traced(body, fields) && json::get_str(body, "team_id") == Some(team_id)
}

/// Shared handles a chat operation runs with.
pub type Shared = (Arc<App>, Team);
