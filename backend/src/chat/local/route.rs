//! The credential-bound stateless planner and router: a capability plan over a closed shortlist, and an intent route
//! that classifies a message or selects from a bounded Assistant directory; neither holds lifecycle authority.

use team_protocol::{
    payload::canonical_locale,
    python::text,
    turn::{
        MAX_CAPABILITY_SELECTED, MAX_INTENT_ROUTE_CANDIDATES, MAX_INTENT_ROUTE_NAME_CHARS,
        MAX_INTENT_ROUTE_QUERY_CHARS, MAX_INTENT_ROUTE_REPLY_CHARS, MAX_INTENT_ROUTE_SELECTED,
        MAX_INTENT_ROUTE_SUMMARY_CHARS,
    },
    websocket::public_text,
};

use super::{
    Answer, closed_traced_for, credential_record_invalid, model_credential, routable, safe_error,
};
use crate::{
    chat::{assistants::proposal::AssistantReference, payloads},
    fault::{Fault, Reply},
    history::context::{self, Entry},
    json::{self, Value},
    process::app::App,
    space::keys::{decision, models::KeyError},
    team::{bridge, transport::Team},
};

/// What a classification may know beside the message: the Assistant the conversation was about, the conversation, and
/// the interface language every route reply is written in (ADR-0090).
#[derive(Clone, Debug, Default)]
pub struct IntentRouteContext {
    /// The Assistant a recent lifecycle turn named.
    pub reference: Option<AssistantReference>,
    /// The committed conversation before the message.
    pub conversation: Vec<Entry>,
    /// The interface language.
    pub locale: Option<String>,
}

fn refused(reason: &str) -> Fault {
    Fault::team_request(reason)
}

fn invalid_response() -> Answer {
    Answer::code(502, "chat-response-invalid")
}

fn ids(raw: &Value, maximum: usize) -> Option<Vec<String>> {
    let items = json::as_array(raw).filter(|items| items.len() <= maximum)?;
    let ids: Vec<String> = items
        .iter()
        .map(payloads::assistant_id)
        .collect::<Result<_, _>>()
        .ok()?;
    ids.windows(2).all(|pair| pair[0] < pair[1]).then_some(ids)
}

fn project_plan(response: &Reply, team_id: &str) -> Option<Answer> {
    let body = &response.body;
    if !closed_traced_for(body, &["team_id", "status", "assistant_ids"], team_id) {
        return None;
    }
    let status = json::get_str(body, "status")
        .filter(|status| matches!(*status, "sufficient" | "install-required"))?;
    let selected = ids(body.get("assistant_ids")?, MAX_CAPABILITY_SELECTED)?;
    if (status == "sufficient") != selected.is_empty() {
        return None;
    }
    Some(Answer::public(
        response.status,
        json::object(vec![
            ("team_id", json::text(team_id)),
            ("status", json::text(status)),
            ("assistant_ids", json::strings(selected)),
        ]),
    ))
}

/// One credential-bound stateless planner result without lifecycle authority.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn capability_plan(
    app: &App,
    team: &Team,
    team_id: &str,
    objective: &Value,
    candidates: Vec<Value>,
) -> Result<Answer, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let credential = match model_credential(app, team, &id).await? {
        Ok(credential) => credential,
        Err(refusal) => return Ok(refusal),
    };
    let payload = json::object(vec![
        ("objective", routable(objective)),
        ("candidates", Value::Array(candidates)),
    ]);
    let response = bridge::capability_plan(team, &id, &payload, &credential).await?;
    if !response.success() {
        return Ok(safe_error(&response));
    }
    Ok(project_plan(&response, &id).unwrap_or_else(invalid_response))
}

fn directory_entry(candidate: &Value, expected: Option<&str>) -> Result<String, Fault> {
    let invalid = || refused("invalid Assistant directory");
    if !json::has_exactly(candidate, &["id", "name", "summary"]) {
        return Err(invalid());
    }
    let id = payloads::assistant_id(candidate.get("id").unwrap_or(&Value::Null))?;
    let name = json::get_str(candidate, "name").ok_or_else(invalid)?;
    let summary = json::get_str(candidate, "summary").ok_or_else(invalid)?;
    if text::strip(name) != name
        || !(1..=MAX_INTENT_ROUTE_NAME_CHARS).contains(&text::len(name))
        || text::strip(summary) != summary
        || text::len(summary) > MAX_INTENT_ROUTE_SUMMARY_CHARS
        || (expected == Some("assistant-uninstall") && !summary.is_empty())
    {
        return Err(invalid());
    }
    Ok(id)
}

fn directory(expected: Option<&str>, candidates: &[Value]) -> Result<Vec<String>, Fault> {
    if candidates.len() > MAX_INTENT_ROUTE_CANDIDATES {
        return Err(refused("invalid Assistant directory"));
    }
    let ids: Vec<String> = candidates
        .iter()
        .map(|candidate| directory_entry(candidate, expected))
        .collect::<Result<_, _>>()?;
    if expected.is_none() && !candidates.is_empty() {
        return Err(refused(
            "classification cannot include an Assistant directory",
        ));
    }
    if expected.is_some() && !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(refused("Assistant directory must be unique and sorted"));
    }
    Ok(ids)
}

fn route_context(
    expected: Option<&str>,
    context: &IntentRouteContext,
) -> Result<(Value, Vec<Value>, String), Fault> {
    let locale = context
        .locale
        .as_deref()
        .and_then(|locale| canonical_locale(&json::text(locale)).map(str::to_owned))
        .ok_or_else(|| refused("Assistant lifecycle context is invalid"))?;
    let reference = match &context.reference {
        None => Value::Null,
        Some(_) if expected.is_some() => {
            return Err(refused(
                "Assistant lifecycle reference is classification-only",
            ));
        }
        Some(reference) => {
            let id = payloads::assistant_id(&json::text(&reference.assistant_id))?;
            let name = json::text(&reference.name);
            let shown = public_text(&name, MAX_INTENT_ROUTE_NAME_CHARS)
                .map_err(|_| refused("Assistant lifecycle reference is invalid"))?;
            json::object(vec![("id", json::text(id)), ("name", json::text(shown))])
        }
    };
    let conversation = context::admit(&context.conversation)
        .map_err(|_| refused("Assistant conversation context is invalid"))?;
    if expected.is_some() && (reference != Value::Null || !conversation.is_empty()) {
        return Err(refused(
            "Assistant lifecycle context is selection-incompatible",
        ));
    }
    Ok((
        reference,
        conversation.iter().map(Entry::wire).collect(),
        locale,
    ))
}

/// What a route answer may carry, checked against what was asked.
struct Asked<'a> {
    team_id: &'a str,
    expected: Option<&'a str>,
    expected_ids: &'a [String],
    capability: bool,
}

fn route_valid(
    intent: &str,
    query: &str,
    selected: &[String],
    reply: &str,
    asked: &Asked<'_>,
) -> bool {
    match asked.expected {
        None => {
            let requires_reply = intent == "unresolved"
                || (matches!(intent, "assistant-install" | "assistant-uninstall")
                    && query.is_empty());
            let query_allowed =
                query.is_empty() || !matches!(intent, "ordinary-task" | "unresolved");
            selected.is_empty() && query_allowed && reply.is_empty() != requires_reply
        }
        Some(_) if intent == "unresolved" => {
            query.is_empty() && selected.is_empty() && !reply.is_empty()
        }
        Some(expected) => {
            intent == expected
                && query.is_empty()
                && !selected.is_empty()
                && (expected != "assistant-uninstall" || selected.len() == 1)
                && reply.is_empty()
        }
    }
}

/// A route answer outside what was asked.
struct Unasked;

fn capability_answer(body: &Value, asked: &Asked<'_>) -> Result<Option<Value>, Unasked> {
    if !asked.capability {
        return Ok(None);
    }
    let capability = json::get_str(body, "capability").ok_or(Unasked)?;
    let intent = json::get_str(body, "intent").ok_or(Unasked)?;
    let valid = match capability {
        "possible" => true,
        "not-needed" => intent == "ordinary-task",
        _ => false,
    };
    if valid {
        Ok(Some(json::text(capability)))
    } else {
        Err(Unasked)
    }
}

/// The route answer's scalar fields, each within its bound and as the request allows.
fn route_fields_valid(
    body: &Value,
    intent: &str,
    query: &str,
    reply: &str,
    task_follows: bool,
    asked: &Asked<'_>,
) -> bool {
    let continues_install =
        asked.expected.is_none() && intent == "assistant-install" && !query.is_empty();
    let reply_shown = reply.is_empty()
        || public_text(&json::text(reply), MAX_INTENT_ROUTE_REPLY_CHARS)
            .is_ok_and(|shown| shown == reply);
    (!task_follows || continues_install)
        && json::get_str(body, "team_id") == Some(asked.team_id)
        && matches!(
            intent,
            "ordinary-task" | "assistant-install" | "assistant-uninstall" | "unresolved"
        )
        && text::strip(query) == query
        && text::len(query) <= MAX_INTENT_ROUTE_QUERY_CHARS
        && reply_shown
        && body.get("trace_id").is_some_and(bridge::is_trace_id)
}

fn project_route(response: &Reply, asked: &Asked<'_>) -> Option<Answer> {
    let mut body = response.body.clone();
    let capability = capability_answer(&body, asked).ok()?;
    json::remove(&mut body, "capability");
    if !json::has_exactly(
        &body,
        &[
            "team_id",
            "intent",
            "query",
            "assistant_ids",
            "reply",
            "task_follows",
            "trace_id",
        ],
    ) {
        return None;
    }
    let intent = json::get_str(&body, "intent")?;
    let query = json::get_str(&body, "query")?;
    let reply = json::get_str(&body, "reply")?;
    let Some(Value::Bool(task_follows)) = body.get("task_follows").cloned() else {
        return None;
    };
    let valid = route_fields_valid(&body, intent, query, reply, task_follows, asked);
    let selected = ids(body.get("assistant_ids")?, MAX_INTENT_ROUTE_SELECTED)?;
    if !valid
        || selected.iter().any(|id| !asked.expected_ids.contains(id))
        || !route_valid(intent, query, &selected, reply, asked)
    {
        return None;
    }
    let mut members = vec![
        ("team_id", json::text(asked.team_id)),
        ("intent", json::text(intent)),
        ("query", json::text(query)),
        ("assistant_ids", json::strings(selected)),
        ("reply", json::text(reply)),
        ("task_follows", Value::Bool(task_follows)),
    ];
    if let Some(capability) = capability {
        members.push(("capability", capability));
    }
    Some(Answer::public(response.status, json::object(members)))
}

/// What one intent route asks Team.
pub struct RouteRequest<'a> {
    /// The message or query.
    pub objective: &'a Value,
    /// `None` to classify, or the lifecycle intent whose directory it selects from.
    pub expected: Option<&'static str>,
    /// The directory.
    pub candidates: &'a [Value],
    /// The classification's context.
    pub context: &'a IntentRouteContext,
    /// The installable Assistants a keyed classification may describe (ADR-0077 amendment).
    pub installable: &'a [Value],
}

/// One credential-bound structured route without lifecycle authority. A classification sent with the decision key may
/// describe the installable Assistants, and its answer then says whether the task needs a capability.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::TeamRequest`] for a directory or context outside its contract.
pub async fn intent_route(
    app: &App,
    team: &Team,
    team_id: &str,
    request: &RouteRequest<'_>,
) -> Result<Answer, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let expected_ids = directory(request.expected, request.candidates)?;
    let (reference, conversation, locale) = route_context(request.expected, request.context)?;
    let credential = match model_credential(app, team, &id).await? {
        Ok(credential) => credential,
        Err(refusal) => return Ok(refusal),
    };
    let decision_key = if request.expected.is_none() {
        match decision::resolve(&app.store) {
            Ok(key) => key,
            Err(KeyError::Record) => return Ok(credential_record_invalid()),
            Err(_) => return Err(Fault::Internal),
        }
    } else {
        None
    };
    let described = decision_key.is_some() && !request.installable.is_empty();
    let mut members = vec![
        ("objective", routable(request.objective)),
        (
            "expected_intent",
            request.expected.map_or(Value::Null, json::text),
        ),
        ("candidates", Value::Array(request.candidates.to_vec())),
        ("lifecycle_reference", reference),
        ("conversation", Value::Array(conversation)),
        ("locale", json::text(locale)),
    ];
    if described {
        members.push(("installable", Value::Array(request.installable.to_vec())));
    }
    let payload = json::object(members);
    let response =
        bridge::intent_route(team, &id, &payload, &credential, decision_key.as_deref()).await?;
    if !response.success() {
        return Ok(safe_error(&response));
    }
    let asked = Asked {
        team_id: &id,
        expected: request.expected,
        expected_ids: &expected_ids,
        capability: described,
    };
    Ok(project_route(&response, &asked).unwrap_or_else(invalid_response))
}
