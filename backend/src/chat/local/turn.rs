//! One Team turn and its continuations, each submitted with the Supervisor's key in private headers and answered only
//! in its closed public shape; and the reads and Stop of a Team's pending chat.

use std::{sync::Arc, time::Instant};

use team_protocol::{
    payload::{
        canonical_clarification, canonical_team_name, canonical_turn_usage, render_clarification,
    },
    python::text,
    turn::{MAX_REPLY_CHARS, REPLY_CONTROL_RE},
};

use super::{
    Answer, MISSING_RUNTIME_STATUSES, canonical_public_progress, challenge, closed_traced_for,
    fields::{BROWSER_FIELD, OPTIONAL_DONE_FIELDS, USAGE_FIELD},
    model_credential, progress, safe_error, unavailable,
};
use crate::{
    app::App,
    chat::payloads,
    fault::{Fault, Reply},
    history::context::Entry,
    json::{self, Value},
    team::{
        bridge::{self, Credential},
        transport::Team,
    },
};

/// Where a turn's public progress goes.
pub type Progress = Arc<dyn Fn(Value) + Send + Sync>;

fn emit(callback: &Progress, event: &Value) {
    if let Ok(canonical) = canonical_public_progress(event) {
        callback(canonical);
    }
}

/// One of Admin's own timed phases.
struct Span<'a> {
    callback: &'a Progress,
    phase: &'static str,
    started: Instant,
}

impl<'a> Span<'a> {
    fn start(callback: &'a Progress, phase: &'static str) -> Self {
        emit(
            callback,
            &json::object(vec![
                ("origin", json::text("admin")),
                ("phase", json::text(phase)),
                ("state", json::text("started")),
            ]),
        );
        Self {
            callback,
            phase,
            started: Instant::now(),
        }
    }
}

impl Drop for Span<'_> {
    fn drop(&mut self) {
        let elapsed = i64::try_from(self.started.elapsed().as_millis()).unwrap_or(i64::MAX);
        emit(
            self.callback,
            &json::object(vec![
                ("origin", json::text("admin")),
                ("phase", json::text(self.phase)),
                ("state", json::text("finished")),
                ("elapsed_ms", json::int(elapsed)),
            ]),
        );
    }
}

fn relay(callback: &Progress) -> impl Fn(Value) + Send + Sync + use<> {
    let callback = Arc::clone(callback);
    move |value| {
        if let Ok(event) = progress::team_event(&value) {
            let mut members = vec![("origin".to_owned(), json::text("team"))];
            members.extend(json::members(&event).unwrap_or_default().iter().cloned());
            emit(&callback, &Value::Object(members));
        }
    }
}

fn clarification_text(clarification: &Value) -> String {
    if *clarification == Value::Null {
        return String::new();
    }
    let mut parts = vec![
        json::get_str(clarification, "question")
            .unwrap_or_default()
            .to_owned(),
    ];
    for option in clarification
        .get("options")
        .and_then(json::as_array)
        .unwrap_or_default()
    {
        parts.push(format!(
            "{} {}",
            json::get_str(option, "label").unwrap_or_default(),
            json::get_str(option, "description").unwrap_or_default()
        ));
    }
    parts.join(" ")
}

fn turn_fields_valid(body: &Value, team_id: &str, reply: &Value, routine_present: bool) -> bool {
    let mut required: Vec<&str> = json::members(body)
        .unwrap_or_default()
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| !OPTIONAL_DONE_FIELDS.contains(name))
        .collect();
    required.sort_unstable();
    let Some(reply) = json::as_str(reply) else {
        return false;
    };
    required == ["clarification", "reply", "team_id", "team_name", "trace_id"]
        && json::get_str(body, "team_id") == Some(team_id)
        && body.get("trace_id").is_some_and(bridge::is_trace_id)
        && canonical_team_name(body.get("team_name").unwrap_or(&Value::Null)).is_some()
        && !(text::strip(reply).is_empty() && (!reply.is_empty() || !routine_present))
        && text::len(reply) <= MAX_REPLY_CHARS
        && REPLY_CONTROL_RE.is_absent(reply)
}

/// The admitted optional parts of a completed turn: its clarification, usage, Browser files, and Routine fields.
struct Extras {
    clarification: Value,
    usage: Option<Value>,
    browser: Option<Value>,
    routine: Vec<(String, Value)>,
}

fn extras(body: &Value) -> Option<Extras> {
    let reply = body.get("reply").unwrap_or(&Value::Null);
    let clarification = match body.get("clarification").unwrap_or(&Value::Null) {
        Value::Null => Value::Null,
        raw => {
            let canonical = canonical_clarification(raw)?;
            if json::as_str(reply) != Some(render_clarification(&canonical).as_str()) {
                return None;
            }
            canonical
        }
    };
    let usage = body
        .get(USAGE_FIELD)
        .map(canonical_turn_usage)
        .map(|usage| usage.ok_or(()))
        .transpose()
        .ok()?;
    let routine = super::admit_routine_fields(body, &clarification)?;
    let browser = body
        .get(BROWSER_FIELD)
        .map(team_protocol::browser::canonical_terminal)
        .map(|browser| browser.ok_or(()))
        .transpose()
        .ok()?;
    Some(Extras {
        clarification,
        usage,
        browser,
        routine,
    })
}

fn shown_text(body: &Value, extras: &Extras) -> String {
    let mut parts = vec![format!(
        "{} {} {}",
        json::get_str(body, "team_name").unwrap_or_default(),
        json::get_str(body, "reply").unwrap_or_default(),
        clarification_text(&extras.clarification)
    )];
    for model in extras
        .usage
        .as_ref()
        .and_then(|usage| usage.get("models"))
        .and_then(json::as_array)
        .unwrap_or_default()
    {
        parts.push(format!(
            "{} {}",
            json::get_str(model, "provider").unwrap_or_default(),
            json::get_str(model, "model").unwrap_or_default()
        ));
    }
    parts.push(json::compact(&Value::Object(extras.routine.clone())));
    parts.push(json::compact(
        extras.browser.as_ref().unwrap_or(&Value::Null),
    ));
    parts.join(" ")
}

/// A completed turn in its closed public shape; a reply that would show the key is refused.
#[must_use]
pub fn project_turn(response: &Reply, team_id: &str, forbidden: &[&str]) -> Answer {
    let body = &response.body;
    let Some(extras) = extras(body) else {
        return Answer::code(502, "chat-response-invalid");
    };
    let reply = body.get("reply").unwrap_or(&Value::Null);
    let shown = shown_text(body, &extras);
    if !turn_fields_valid(body, team_id, reply, !extras.routine.is_empty())
        || forbidden
            .iter()
            .any(|value| !value.is_empty() && shown.contains(value))
    {
        return Answer::code(502, "chat-response-invalid");
    }
    let mut members = vec![
        ("team_id".to_owned(), json::text(team_id)),
        (
            "team_name".to_owned(),
            body.get("team_name").cloned().unwrap_or(Value::Null),
        ),
        ("reply".to_owned(), reply.clone()),
        ("clarification".to_owned(), extras.clarification),
    ];
    if let Some(usage) = extras.usage {
        members.push((USAGE_FIELD.to_owned(), usage));
    }
    if let Some(browser) = extras.browser {
        members.push((BROWSER_FIELD.to_owned(), browser));
    }
    members.extend(extras.routine);
    Answer::public(response.status, Value::Object(members))
}

/// Which Team call a submission makes.
pub enum Submission {
    /// A new turn of this payload with its conversation window and request identity.
    Turn {
        /// The admitted chat payload.
        payload: Value,
        /// The committed conversation before the message.
        conversation: Vec<Entry>,
        /// The send's request identity (ADR-0092).
        request: Value,
    },
    /// The continuation after an Integration was connected.
    Integrations {
        /// The paused challenge.
        challenge_id: String,
    },
    /// The continuation after a human answer.
    Human {
        /// The answer's continuation payload.
        payload: Value,
        /// The assurance an authenticated answer carries.
        assurance: Option<Value>,
    },
}

impl Submission {
    fn body(&self) -> Result<Value, Fault> {
        match self {
            Self::Turn {
                payload,
                conversation,
                request,
            } => {
                let mut merged = payload.clone();
                if json::members(&merged).is_some() {
                    json::set(
                        &mut merged,
                        "conversation",
                        Value::Array(conversation.iter().map(Entry::wire).collect()),
                    );
                    json::set(&mut merged, "request", request.clone());
                }
                payloads::team_chat_body(&merged)
            }
            Self::Integrations { challenge_id } => payloads::integration_resume(&json::object(
                vec![("challenge_id", json::text(challenge_id))],
            )),
            Self::Human { payload, .. } => payloads::human_resume(payload),
        }
    }

    /// The interface language Team renders a pending human request in (ADR-0091).
    fn locale(&self) -> Option<String> {
        match self {
            Self::Turn { payload, .. } => json::get_str(payload, "locale").map(str::to_owned),
            _ => None,
        }
    }
}

async fn request(
    app: &App,
    team: &Team,
    id: &str,
    submission: &Submission,
    body: &Value,
    credential: &Credential,
    progress: &Progress,
) -> Result<Reply, Fault> {
    let relay = relay(progress);
    match submission {
        Submission::Turn { .. } => bridge::chat(team, id, body, credential, &relay).await,
        Submission::Integrations { .. } => {
            bridge::resume_chat_integrations(team, id, body, credential, &relay).await
        }
        Submission::Human { assurance, .. } => {
            bridge::resume_chat_human(
                team,
                &app.topics,
                id,
                body,
                credential,
                assurance.as_ref(),
                &relay,
            )
            .await
        }
    }
}

/// Submits one turn or continuation and projects Team's answer.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for a request Admin refuses before Team, or the Team request's fault.
pub async fn submit(
    app: &App,
    team: &Team,
    team_id: &str,
    submission: Submission,
    progress: &Progress,
) -> Result<Answer, Fault> {
    let (id, body, credential) = {
        let _span = Span::start(progress, "admin-preparation");
        let id = payloads::team_id(&json::text(team_id))?;
        let body = submission.body()?;
        let credential = model_credential(app, team, &id).await?;
        (id, body, credential)
    };
    let credential = match credential {
        Ok(credential) => credential,
        Err(refusal) => return Ok(refusal),
    };
    let response = request(app, team, &id, &submission, &body, &credential, progress).await?;
    if MISSING_RUNTIME_STATUSES.contains(&response.status) {
        return Ok(unavailable());
    }
    if response.status == 428 {
        return Ok(challenge::project_pending_challenge(
            &response,
            &id,
            submission.locale().as_deref(),
        ));
    }
    if response.get_str("status") == Some("human-denied") {
        return Ok(challenge::project_human_denial(&response, &id));
    }
    if !response.success() {
        return Ok(safe_error(&response));
    }
    let _span = Span::start(progress, "reply-validation");
    Ok(project_turn(&response, &id, &[credential.api_key.as_str()]))
}

enum Pending {
    Integrations,
    Human(String),
}

async fn pending(team: &Team, team_id: &str, kind: Pending) -> Result<Answer, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = match &kind {
        Pending::Integrations => bridge::pending_chat_integrations(team, &id).await?,
        Pending::Human(locale) => bridge::open_chat_human(team, &id, locale).await?,
    };
    if MISSING_RUNTIME_STATUSES.contains(&response.status) {
        return Ok(unavailable());
    }
    if !response.success() {
        return Ok(safe_error(&response));
    }
    if !json::has_exactly(&response.body, &["team_id", "status", "trace_id"]) {
        return Ok(match kind {
            Pending::Integrations => challenge::project_integration_challenge(&response, &id),
            Pending::Human(locale) => {
                challenge::project_pending_challenge(&response, &id, Some(&locale))
            }
        });
    }
    if response.get_str("team_id") == Some(id.as_str())
        && response.get_str("status") == Some("none")
        && response.get("trace_id").is_some_and(bridge::is_trace_id)
    {
        return Ok(Answer::public(
            response.status,
            json::object(vec![
                ("team_id", json::text(&id)),
                ("status", json::text("none")),
            ]),
        ));
    }
    Ok(Answer::code(
        502,
        match kind {
            Pending::Integrations => "integration-challenge-response-invalid",
            Pending::Human(_) => "human-challenge-response-invalid",
        },
    ))
}

/// The Team's pending Integration challenge, or that none is pending.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn pending_integrations(team: &Team, team_id: &str) -> Result<Answer, Fault> {
    pending(team, team_id, Pending::Integrations).await
}

/// The Team's pending human challenge rendered in the selected interface language, or that none is pending.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn open_human(team: &Team, team_id: &str, locale: &str) -> Result<Answer, Fault> {
    pending(team, team_id, Pending::Human(locale.to_owned())).await
}

/// Asks Team to stop the Team's chat: whether the active turn token was cancelled (`stopped`).
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn stop(team: &Team, team_id: &str) -> Result<Answer, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = bridge::stop_chat(team, &id).await?;
    if MISSING_RUNTIME_STATUSES.contains(&response.status) {
        return Ok(unavailable());
    }
    if !response.success() {
        return Ok(safe_error(&response));
    }
    let flag = |key| match response.get(key) {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    };
    let fields = [
        "team_id",
        "requested",
        "accepted",
        "confirmed",
        "forced_restart",
    ];
    let valid = closed_traced_for(&response.body, &fields, &id);
    match (
        flag("requested"),
        flag("accepted"),
        flag("confirmed"),
        flag("forced_restart"),
    ) {
        (Some(requested), Some(accepted), Some(confirmed), Some(forced))
            if valid && requested == accepted && (accepted || !(confirmed || forced)) =>
        {
            Ok(Answer::public(
                response.status,
                json::object(vec![
                    ("team_id", json::text(&id)),
                    ("stopped", Value::Bool(accepted)),
                ]),
            ))
        }
        _ => Ok(Answer::code(502, "chat-stop-response-invalid")),
    }
}
