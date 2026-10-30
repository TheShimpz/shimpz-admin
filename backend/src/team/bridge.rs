//! The bounded Admin to Team bridge for Teams, inference, chat, Assistants, files, and the Browser view.
//!
//! Admin owns the signed browser session but never a Docker socket; Team owns runtime lifecycle and admission. Team's
//! JSON and statuses pass through so a safe 400, 404, or 409 is never flattened, while every success is admitted only
//! in its closed shape and every unchecked body becomes Admin's own error.

use std::time::Duration;

use team_protocol::{
    browser_view as view_contract,
    payload::{self as team_contract, MAX_TEAM_REGISTRY_BYTES},
    preview,
    turn::{MAX_CAPABILITY_PLAN_BODY_BYTES, MAX_INTENT_ROUTE_BODY_BYTES},
};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use super::transport::{self, AssetReply, Bindings, Image, Options, Team};
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

/// Every admissible Assistant of the Space by identity and name.
pub async fn list_assistants(team: &Team) -> Reply {
    team.call("GET", "/v1/assistants", None)
        .await
        .unwrap_or_else(|_| transport::unavailable())
}

/// One Team's admitted Assistants with the names, summaries, and Actions its own bindings declare.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn team_assistant_registry(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    team.call_with(
        "GET",
        &format!("/v1/teams/{id}/assistant-registry"),
        None,
        Options {
            response_limit: MAX_TEAM_REGISTRY_BYTES,
            ..Options::default()
        },
    )
    .await
}

/// The unpublished snapshots the Local Team exposes.
pub async fn list_local_assistants(team: &Team) -> Reply {
    team.call("GET", "/v1/local-assistants", None)
        .await
        .unwrap_or_else(|_| transport::unavailable())
}

fn local_assistant_path(image_id: &str) -> Result<String, Fault> {
    let digest = source_digest(&json::text(image_id))?;
    Ok(format!(
        "/v1/local-assistants/{}",
        digest.trim_start_matches("sha256:")
    ))
}

/// One exact unpublished image's admitted PNG preview.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id.
pub async fn local_assistant_icon(team: &Team, image_id: &str) -> Result<AssetReply, Fault> {
    let path = local_assistant_path(image_id)?;
    Ok(team.call_image(&format!("{path}/icon"), Image::Icon).await)
}

/// One exact unpublished image's summary in one interface language, from its own pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id or locale.
pub async fn local_assistant_summary(
    team: &Team,
    image_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = local_assistant_path(image_id)?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/summary/{locale}"), None)
        .await
}

/// One exact unpublished image's page in one interface language.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id or locale.
pub async fn local_assistant_details(
    team: &Team,
    image_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = local_assistant_path(image_id)?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/details/{locale}"), None)
        .await
}

fn assistant_path(team_id: &str, assistant_id: Option<&str>) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let base = format!("/v1/teams/{id}/assistants");
    match assistant_id {
        None => Ok(base),
        Some(assistant) => Ok(format!(
            "{base}/{}",
            payloads::assistant_id(&json::text(assistant))?
        )),
    }
}

/// The Team's installed Assistants.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list_installed_assistants(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    team.call("GET", &assistant_path(team_id, None)?, None)
        .await
}

/// One installed Assistant's icon.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn assistant_icon(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
) -> Result<AssetReply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    Ok(team.call_image(&format!("{path}/icon"), Image::Icon).await)
}

/// One installed Assistant's summary in one interface language, from its binding's pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or locale.
pub async fn assistant_summary(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/summary/{locale}"), None)
        .await
}

/// One installed Assistant's page in one interface language, from its exact binding and pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or locale.
pub async fn assistant_details(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/details/{locale}"), None)
        .await
}

fn install_options() -> Options {
    Options {
        timeout: ASSISTANT_INSTALL_TIMEOUT,
        ..Options::default()
    }
}

/// Installs one exact public Store selection; a committed install raises the Team's inventory topics.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    if !json::has_exactly(payload, &["assistant_id", "source_digest"]) {
        return Err(Fault::team_request(
            "request body must contain only assistant_id and source_digest",
        ));
    }
    let assistant = payloads::assistant_id(payload.get("assistant_id").unwrap_or(&Value::Null))?;
    let digest = source_digest(payload.get("source_digest").unwrap_or(&Value::Null))?;
    let path = assistant_path(team_id, None)?;
    let response = team
        .call_with(
            "POST",
            &path,
            Some(&json::object(vec![
                ("assistant_id", json::text(assistant)),
                ("source_digest", json::text(digest)),
            ])),
            install_options(),
        )
        .await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}

async fn install_local(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
    route: &str,
) -> Result<Reply, Fault> {
    if !json::has_exactly(payload, &["image_id"]) {
        return Err(Fault::team_request(
            "request body must contain only image_id",
        ));
    }
    let image = source_digest(payload.get("image_id").unwrap_or(&Value::Null))?;
    let path = assistant_path(team_id, None)?;
    let response = team
        .call_with(
            "POST",
            &format!("{path}/{route}"),
            Some(&json::object(vec![("image_id", json::text(image))])),
            install_options(),
        )
        .await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}

/// Installs one exact staged image.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_local_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    install_local(team, topics, team_id, payload, "local").await
}

/// Installs one exact staged image only when the Team does not hold that Assistant yet.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_fresh_local_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    install_local(team, topics, team_id, payload, "local/fresh").await
}

/// Uninstalls one Assistant.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn uninstall_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    assistant_id: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let response = team.call("DELETE", &path, None).await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}

fn files_path(team_id: &str, file_id: Option<&str>) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let base = format!("/v1/teams/{id}/files");
    match file_id {
        None => Ok(base),
        Some(file) => Ok(format!("{base}/{}", payloads::file_id(&json::text(file))?)),
    }
}

fn project_storage(response: &Reply, team_id: &str, kind: &str) -> Reply {
    if !response.success() {
        let mut error: Vec<(&str, Value)> = Vec::new();
        for key in ["detail", "error", "code"] {
            if let Some(text) = response
                .get_str(key)
                .filter(|text| (1..=500).contains(&team_protocol::python::text::len(text)))
            {
                error.push((key, json::text(text)));
            }
        }
        if error.is_empty() {
            error.push(("detail", json::text("team request failed")));
        }
        return Reply::new(response.status, json::object(error));
    }
    match team_contract::project_storage_response(&response.body, kind, team_id) {
        Some(body) => Reply::new(response.status, body),
        None => transport::unavailable(),
    }
}

/// Uploads one file's bytes to the Team, named and typed as Team admits them.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id, name, type, or size.
pub async fn upload_file(
    team: &Team,
    team_id: &str,
    filename: &str,
    media_type: &str,
    content: &[u8],
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let name = team_contract::canonical_filename(&json::text(filename))
        .map(str::to_owned)
        .ok_or_else(|| Fault::team_request("filename must be a trimmed, non-path UTF-8 name"))?;
    let kind = team_contract::canonical_media_type(&json::text(media_type))
        .ok_or_else(|| Fault::team_request("invalid media type"))?;
    let limit = usize::try_from(team_contract::MAX_FILE_UPLOAD_BYTES).unwrap_or(usize::MAX);
    if content.is_empty() {
        return Err(Fault::team_request("file must contain bytes"));
    }
    if content.len() > limit {
        return Err(Fault::team_request(format!("file exceeds {limit} bytes")));
    }
    let response = team
        .call_raw("POST", &files_path(&id, None)?, content, &name, &kind)
        .await;
    Ok(project_storage(&response, &id, "upload"))
}

/// The Team's files and storage usage.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list_files(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team.call("GET", &files_path(&id, None)?, None).await?;
    Ok(project_storage(&response, &id, "list"))
}

const PREVIEW_REFUSALS: &[(u16, &[&str])] = &[
    (404, &["file-not-found", "team-not-found"]),
    (422, &["file-preview-unsupported"]),
    (503, &["file-preview-busy", "file-preview-unavailable"]),
];
const CONTENT_REFUSALS: &[(u16, &[&str])] = &[
    (403, &["file-acknowledgement-required"]),
    (404, &["file-not-found", "team-not-found"]),
    (503, &["file-download-busy"]),
];
const ACKNOWLEDGEMENT_REFUSALS: &[(u16, &[&str])] = &[
    (403, &["file-acknowledgement-required"]),
    (404, &["file-not-found", "team-not-found"]),
    (409, &["file-not-from-web"]),
];
const VIEW_REFUSALS: &[(u16, &[&str])] = &[
    (404, &[view_contract::NOT_RUNNING, "team-not-found"]),
    (503, &[view_contract::BUSY, view_contract::UNAVAILABLE]),
];

fn closed_code<'a>(
    refusals: &[(u16, &[&str])],
    status: u16,
    code: Option<&'a str>,
) -> Option<&'a str> {
    let code = code?;
    refusals
        .iter()
        .any(|(known, codes)| *known == status && codes.contains(&code))
        .then_some(code)
}

fn file_bytes(response: AssetReply, refusals: &[(u16, &[&str])], detail: &str) -> AssetReply {
    if response.contents.is_some() {
        return response;
    }
    let code = json::get_str(&response.error, "code");
    let Some(code) = closed_code(refusals, response.status, code) else {
        return AssetReply::unavailable();
    };
    let mut error = vec![("detail", json::text(detail)), ("code", json::text(code))];
    let retry = response.error.get("retry_after_ms").and_then(json::as_int);
    if matches!(code, "file-preview-busy" | "file-download-busy")
        && let Some(retry) = retry.filter(|retry| (1..=MAX_PREVIEW_RETRY_MS).contains(retry))
    {
        error.push(("retry_after_ms", json::int(retry)));
    }
    AssetReply {
        error: json::object(error),
        ..response
    }
}

/// One Team file's sanitized image rendition, or its closed refusal (ADR-0093).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn file_preview(team: &Team, team_id: &str, file_id: &str) -> Result<AssetReply, Fault> {
    let path = files_path(team_id, Some(file_id))?;
    let response = team
        .call_image(&format!("{path}/preview"), Image::Preview)
        .await;
    Ok(file_bytes(
        response,
        PREVIEW_REFUSALS,
        "file preview unavailable",
    ))
}

/// One page of a Team PDF as a sanitized rendition with its page count, or its closed refusal.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or page.
pub async fn file_page_preview(
    team: &Team,
    team_id: &str,
    file_id: &str,
    page: &str,
) -> Result<AssetReply, Fault> {
    let page = preview::canonical_page(&json::text(page))
        .ok_or_else(|| Fault::team_request("page must be a number from 1 to 50"))?;
    let path = files_path(team_id, Some(file_id))?;
    let response = team
        .call_image(&format!("{path}/pages/{page}/preview"), Image::PagePreview)
        .await;
    Ok(file_bytes(
        response,
        PREVIEW_REFUSALS,
        "file preview unavailable",
    ))
}

/// Records the Supervisor's acknowledgement of one file from the web before its original is saved.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn acknowledge_file(team: &Team, team_id: &str, file_id: &str) -> Result<Reply, Fault> {
    let file = payloads::file_id(&json::text(file_id))?;
    let path = files_path(team_id, Some(&file))?;
    let response = team
        .call("POST", &format!("{path}/acknowledgement"), None)
        .await?;
    let expected = json::object(vec![
        ("file_id", json::text(&file)),
        ("acknowledged", Value::Bool(true)),
    ]);
    if response.status == 200 && json::equal(&response.body, &expected) {
        return Ok(response);
    }
    Ok(
        match closed_code(
            ACKNOWLEDGEMENT_REFUSALS,
            response.status,
            response.get_str("code"),
        ) {
            Some(code) => Reply::new(
                response.status,
                json::detail_code("file acknowledgement unavailable", code),
            ),
            None => transport::unavailable(),
        },
    )
}

/// One Team file's original, verified against its digest, or its closed refusal.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn file_content(team: &Team, team_id: &str, file_id: &str) -> Result<AssetReply, Fault> {
    let path = files_path(team_id, Some(file_id))?;
    let response = team.call_content(&format!("{path}/content")).await;
    Ok(file_bytes(
        response,
        CONTENT_REFUSALS,
        "file download unavailable",
    ))
}

/// The view id of the Browser task the Team runs now, for the Supervisor to watch its screen.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn open_browser_view(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team
        .call("POST", &format!("/v1/teams/{id}/browser/view"), None)
        .await?;
    if response.status == 200 && closed_traced(&response.body, &["view_id"]) {
        let view = json::object(vec![(
            "view_id",
            response.get("view_id").cloned().unwrap_or(Value::Null),
        )]);
        if view_contract::canonical_view(&view).is_some() {
            return Ok(Reply::ok(view));
        }
    }
    Ok(
        match closed_code(VIEW_REFUSALS, response.status, response.get_str("code")) {
            Some(code) => Reply::new(
                response.status,
                json::detail_code("browser view unavailable", code),
            ),
            None => transport::unavailable(),
        },
    )
}
