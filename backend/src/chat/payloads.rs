//! Fail-closed canonicalizers of the identifiers and chat payloads a browser sends; each refusal is a request Admin
//! refuses before any Team call.

use team_protocol::{
    identifiers,
    payload::{self as team_contract, CHAT_BODY_FIELDS, MAX_CHAT_ASSISTANTS, MAX_CHAT_FILES},
    python::text,
    routine as routine_contract,
    supervisor::ASSURANCE_KINDS,
    turn::MAX_CHAT_MESSAGE_CHARS,
    websocket::{human_value, valid_challenge_id},
};

use crate::{
    fault::Fault,
    json::{self, Value},
};

/// The browser's chat fields: the message, its files and Assistant scope, its interface language, the browser's zone
/// for a Routine it creates (or null), and the Routine it refines (or null).
pub const CHAT_PAYLOAD_FIELDS: [&str; 6] = [
    "message",
    "files",
    "assistant_ids",
    "locale",
    "timezone",
    "refine",
];

fn refused(reason: &str) -> Fault {
    Fault::team_request(reason)
}

/// One canonical Team id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn team_id(value: &Value) -> Result<String, Fault> {
    identifiers::canonical_team_id(value)
        .map(str::to_owned)
        .ok_or_else(|| refused("team id must be a canonical lowercase identifier"))
}

/// One canonical Assistant id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn assistant_id(value: &Value) -> Result<String, Fault> {
    identifiers::canonical_assistant_id(value)
        .map(str::to_owned)
        .ok_or_else(|| refused("assistant id must be a canonical lowercase identifier"))
}

/// One Integration, provider, or Stored Input identifier.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn identifier(value: &Value) -> Result<String, Fault> {
    identifiers::canonical_identifier(value)
        .map(str::to_owned)
        .ok_or_else(|| refused("identifier must be a canonical lowercase identifier"))
}

/// One canonical Action id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn action_id(value: &Value) -> Result<String, Fault> {
    identifiers::canonical_action_id(value)
        .map(str::to_owned)
        .ok_or_else(|| refused("Action id must be a canonical Action identifier"))
}

/// One interface language exactly as Team admits it (ADR-0090).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn locale(value: &Value) -> Result<String, Fault> {
    team_contract::canonical_locale(value)
        .map(str::to_owned)
        .ok_or_else(|| refused("locale must be one interface language"))
}

/// One 32-hex challenge id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn challenge_id(value: &Value) -> Result<String, Fault> {
    if valid_challenge_id(value) {
        Ok(json::as_str(value).unwrap_or_default().to_owned())
    } else {
        Err(refused("OAuth challenge is invalid"))
    }
}

/// One canonical file id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn file_id(value: &Value) -> Result<String, Fault> {
    team_contract::FILE_ID_RE
        .is_full_value(value)
        .then(|| json::as_str(value).unwrap_or_default().to_owned())
        .ok_or_else(|| refused("file id must be a canonical lowercase identifier"))
}

fn unique(items: &[String]) -> bool {
    let mut sorted = items.to_vec();
    sorted.sort();
    sorted.dedup();
    sorted.len() == items.len()
}

/// One explicit Assistant scope (an empty scope is never all), in one interface language.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for a payload outside the chat fields.
pub fn chat_payload(payload: &Value) -> Result<Value, Fault> {
    if !json::has_exactly(payload, &CHAT_PAYLOAD_FIELDS) {
        return Err(refused(
            "chat requires message, files, assistant_ids, locale, timezone, and refine",
        ));
    }
    let field = |name: &str| payload.get(name).unwrap_or(&Value::Null);
    let locale = locale(field("locale"))?;
    let timezone = field("timezone");
    if !matches!(timezone, Value::Null) && routine_contract::canonical_timezone(timezone).is_none()
    {
        return Err(refused("timezone must be one IANA zone name or null"));
    }
    let refine = field("refine");
    if !matches!(refine, Value::Null) && !routine_contract::ROUTINE_ID_RE.is_full_value(refine) {
        return Err(refused("refine must name one Routine or be null"));
    }
    let message = json::as_str(field("message"))
        .map(text::strip)
        .filter(|message| !message.is_empty())
        .ok_or_else(|| refused("message must be non-empty"))?;
    if text::len(message) > MAX_CHAT_MESSAGE_CHARS {
        return Err(refused(&format!(
            "message exceeds {MAX_CHAT_MESSAGE_CHARS} characters"
        )));
    }
    let files = json::as_array(field("files"))
        .filter(|files| files.len() <= MAX_CHAT_FILES)
        .ok_or_else(|| refused(&format!("files must contain at most {MAX_CHAT_FILES} ids")))?
        .iter()
        .map(file_id)
        .collect::<Result<Vec<_>, _>>()?;
    if !unique(&files) {
        return Err(refused("files must not contain duplicate ids"));
    }
    let assistants = json::as_array(field("assistant_ids"))
        .filter(|ids| ids.len() <= MAX_CHAT_ASSISTANTS)
        .ok_or_else(|| {
            refused(&format!(
                "assistant_ids must contain at most {MAX_CHAT_ASSISTANTS} ids"
            ))
        })?
        .iter()
        .map(assistant_id)
        .collect::<Result<Vec<_>, _>>()?;
    if !unique(&assistants) {
        return Err(refused("assistant_ids must not contain duplicate ids"));
    }
    Ok(json::object(vec![
        ("message", json::text(message)),
        ("files", json::strings(files)),
        ("assistant_ids", json::strings(assistants)),
        ("locale", json::text(locale)),
        ("timezone", timezone.clone()),
        ("refine", refine.clone()),
    ]))
}

/// The Team chat body: the browser's chat fields plus Admin's conversation window and request identity.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other body.
pub fn team_chat_body(payload: &Value) -> Result<Value, Fault> {
    if !json::has_exactly(payload, &CHAT_BODY_FIELDS) {
        return Err(refused(
            "Team chat requires the chat fields, conversation, and request",
        ));
    }
    let conversation =
        team_contract::canonical_conversation(payload.get("conversation").unwrap_or(&Value::Null))
            .ok_or_else(|| refused("conversation window is invalid"))?;
    let request =
        team_contract::canonical_request_identity(payload.get("request").unwrap_or(&Value::Null))
            .ok_or_else(|| refused("request identity is invalid"))?;
    let browser = json::object(
        CHAT_PAYLOAD_FIELDS
            .iter()
            .map(|name| (*name, payload.get(name).cloned().unwrap_or(Value::Null)))
            .collect(),
    );
    let mut body = chat_payload(&browser)?;
    json::set(&mut body, "conversation", conversation);
    json::set(&mut body, "request", request);
    Ok(body)
}

/// Exactly `{"challenge_id"}`: the one controller-owned Integration challenge a continuation is bound to.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other payload.
pub fn integration_resume(payload: &Value) -> Result<Value, Fault> {
    if !json::has_exactly(payload, &["challenge_id"]) {
        return Err(refused(
            "integration continuation requires only challenge_id",
        ));
    }
    let challenge = challenge_id(payload.get("challenge_id").unwrap_or(&Value::Null))?;
    Ok(json::object(vec![("challenge_id", json::text(challenge))]))
}

/// One bounded human response, never interpreting the pending Team request.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other payload.
pub fn human_resume(payload: &Value) -> Result<Value, Fault> {
    let decision = json::get_str(payload, "decision")
        .filter(|decision| matches!(*decision, "submit" | "deny"))
        .ok_or_else(|| refused("human continuation requires a submit or deny decision"))?;
    let expected: &[&str] = if decision == "submit" {
        &["challenge_id", "decision", "value"]
    } else {
        &["challenge_id", "decision"]
    };
    if !json::has_exactly(payload, expected) {
        return Err(refused("human continuation fields are invalid"));
    }
    let challenge = challenge_id(payload.get("challenge_id").unwrap_or(&Value::Null))?;
    let mut result = vec![
        ("challenge_id", json::text(challenge)),
        ("decision", json::text(decision)),
    ];
    if decision == "submit" {
        let value = payload.get("value").cloned().unwrap_or(Value::Null);
        if !human_value(&value) {
            return Err(refused("human continuation value is invalid"));
        }
        result.push(("value", value));
    }
    Ok(json::object(result))
}

/// A successful Admin authentication bound to one exact Team challenge.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn human_assurance(value: &Value) -> Result<Value, Fault> {
    if !json::has_exactly(value, &["kind", "challenge_id"]) {
        return Err(refused("human assurance is invalid"));
    }
    let kind = json::get_str(value, "kind")
        .filter(|kind| ASSURANCE_KINDS.contains(kind))
        .ok_or_else(|| refused("human assurance kind is invalid"))?;
    let challenge = challenge_id(value.get("challenge_id").unwrap_or(&Value::Null))?;
    Ok(json::object(vec![
        ("kind", json::text(kind)),
        ("challenge_id", json::text(challenge)),
    ]))
}
