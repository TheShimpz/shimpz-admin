//! Chat turns, plans, routes, the chat limit, and resumed challenges.

use team_protocol::{
    payload::{self as team_contract},
    turn::{MAX_CAPABILITY_PLAN_BODY_BYTES, MAX_INTENT_ROUTE_BODY_BYTES},
};
use zeroize::Zeroizing;

use super::{
    CAPABILITY_PLAN_TIMEOUT, CHAT_LIMIT_TOPIC, CHAT_STREAM_TIMEOUT, INTENT_ROUTE_TIMEOUT,
    MAX_CHAT_JSON_BODY_BYTES, changed, closed_traced, invalid,
};
use crate::team::transport::{self, Bindings, Options, Team};
use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
    session::topics::Topics,
};

/// The model credential a turn carries.
#[derive(Clone)]
pub struct Credential {
    /// The provider.
    pub provider: String,
    /// The key.
    pub api_key: Zeroizing<String>,
}

fn model_bindings(credential: &Credential) -> Bindings {
    Bindings {
        model: Some((credential.provider.clone(), credential.api_key.clone())),
        ..Bindings::default()
    }
}

/// Sends one chat turn whose JSON is secret-free; the key travels only in the private headers.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or body.
pub async fn chat(
    team: &Team,
    team_id: &str,
    payload: &Value,
    credential: &Credential,
    progress: &(dyn Fn(Value) + Send + Sync),
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let body = payloads::team_chat_body(payload)?;
    let options = Options {
        timeout: CHAT_STREAM_TIMEOUT,
        body_limit: MAX_CHAT_JSON_BODY_BYTES,
        bindings: model_bindings(credential),
        ..Options::default()
    };
    team.call_stream(
        "POST",
        &format!("/v1/teams/{id}/chat"),
        &body,
        options,
        progress,
    )
    .await
}

/// One stateless capability plan over a caller-supplied closed shortlist.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn capability_plan(
    team: &Team,
    team_id: &str,
    payload: &Value,
    credential: &Credential,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    if !json::has_exactly(payload, &["objective", "candidates"]) {
        return Err(Fault::team_request(
            "capability plan requires only objective and candidates",
        ));
    }
    let options = Options {
        timeout: CAPABILITY_PLAN_TIMEOUT,
        body_limit: MAX_CAPABILITY_PLAN_BODY_BYTES,
        bindings: model_bindings(credential),
        ..Options::default()
    };
    team.call_with(
        "POST",
        &format!("/v1/teams/{id}/chat/capability-plan"),
        Some(payload),
        options,
    )
    .await
}

/// One stateless intent route; a keyed classification may describe installable Assistants (ADR-0077).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn intent_route(
    team: &Team,
    team_id: &str,
    payload: &Value,
    credential: &Credential,
    decision_key: Option<&str>,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let fields = [
        "objective",
        "expected_intent",
        "candidates",
        "lifecycle_reference",
        "conversation",
        "locale",
    ];
    let mut core = payload.clone();
    json::remove(&mut core, "installable");
    if !json::has_exactly(&core, &fields) {
        return Err(Fault::team_request(
            "intent route requires objective, expected_intent, candidates, and lifecycle context",
        ));
    }
    let mut bindings = model_bindings(credential);
    bindings.decision = decision_key.map(|key| Zeroizing::new(key.to_owned()));
    let options = Options {
        timeout: INTENT_ROUTE_TIMEOUT,
        body_limit: MAX_INTENT_ROUTE_BODY_BYTES,
        bindings,
        ..Options::default()
    };
    team.call_with(
        "POST",
        &format!("/v1/teams/{id}/chat/intent-route"),
        Some(payload),
        options,
    )
    .await
}

fn chat_limit_answer(response: Reply) -> Reply {
    if response.status != 200 {
        return response;
    }
    let limit = team_contract::canonical_chat_limit(&json::without(&response.body, "trace_id"));
    match limit {
        Some(limit) if closed_traced(&response.body, &["limit"]) => Reply::ok(limit),
        _ => invalid("Team returned an invalid chat limit"),
    }
}

/// How many chat turns the Space runs at once, as Team, its owner, answers (ADR-0119).
pub async fn chat_limit(team: &Team) -> Reply {
    chat_limit_answer(
        team.call("GET", "/v1/chat/limit", None)
            .await
            .unwrap_or_else(|_| transport::unavailable()),
    )
}

/// Sets the Space's chat limit; every page that shows it hears of a committed change.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for a limit outside 1 to the maximum.
pub async fn save_chat_limit(team: &Team, topics: &Topics, body: &Value) -> Result<Reply, Fault> {
    let admitted = team_contract::canonical_chat_limit(body).ok_or_else(|| {
        Fault::team_request(format!(
            "the chat limit must be from 1 to {}",
            team_contract::MAX_CHAT_LIMIT
        ))
    })?;
    let response = chat_limit_answer(team.call("PUT", "/v1/chat/limit", Some(&admitted)).await?);
    if response.status == 200 {
        topics.changed(CHAT_LIMIT_TOPIC);
    }
    Ok(response)
}

/// Asks Team to stop the Team's chat.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn stop_chat(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    team.call(
        "POST",
        &format!("/v1/teams/{id}/chat/stop"),
        Some(&json::empty()),
    )
    .await
}

/// The Team's pending Integration challenge, if any.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn pending_chat_integrations(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    team.call("GET", &format!("/v1/teams/{id}/chat/integrations"), None)
        .await
}

/// Opens the Team's pending human challenge with its request copy in one interface language (ADR-0091).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or locale.
pub async fn open_chat_human(team: &Team, team_id: &str, locale: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call(
        "POST",
        &format!("/v1/teams/{id}/chat/human/challenge"),
        Some(&json::object(vec![("locale", json::text(locale))])),
    )
    .await
}

/// Continues a turn after its Integration was connected.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn resume_chat_integrations(
    team: &Team,
    team_id: &str,
    payload: &Value,
    credential: &Credential,
    progress: &(dyn Fn(Value) + Send + Sync),
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let body = payloads::integration_resume(payload)?;
    let options = Options {
        timeout: CHAT_STREAM_TIMEOUT,
        bindings: model_bindings(credential),
        ..Options::default()
    };
    team.call_stream(
        "POST",
        &format!("/v1/teams/{id}/chat/integrations"),
        &body,
        options,
        progress,
    )
    .await
}

/// Continues a turn after a human answer; an admitted answer may have stored an Input for the Team's Assistants.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id, payload, or an assurance that is not this continuation's.
pub async fn resume_chat_human(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
    credential: &Credential,
    assurance: Option<&Value>,
    progress: &(dyn Fn(Value) + Send + Sync),
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let body = payloads::human_resume(payload)?;
    let assurance = match assurance {
        Some(assurance) => {
            let canonical = payloads::human_assurance(assurance)?;
            if json::get_str(&body, "decision") != Some("submit")
                || body.get("value") != Some(&Value::Bool(true))
                || canonical.get("challenge_id") != body.get("challenge_id")
            {
                return Err(Fault::team_request(
                    "human assurance does not match the continuation",
                ));
            }
            Some(canonical)
        }
        None => None,
    };
    let mut bindings = model_bindings(credential);
    bindings.assurance = assurance;
    let options = Options {
        timeout: CHAT_STREAM_TIMEOUT,
        body_limit: MAX_CHAT_JSON_BODY_BYTES,
        bindings,
        ..Options::default()
    };
    let response = team
        .call_stream(
            "POST",
            &format!("/v1/teams/{id}/chat/human"),
            &body,
            options,
            progress,
        )
        .await?;
    if response.status == 428 {
        topics.team_changed(&id, &["integrations"]);
        return Ok(response);
    }
    Ok(changed(response, topics, &id, &["integrations"], false))
}
