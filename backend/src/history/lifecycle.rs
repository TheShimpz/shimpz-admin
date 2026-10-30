//! What a stored Assistant lifecycle event carries: an install plan's or an uninstall's terminal outcome. Pure shape
//! checks, the same when an event is written and when its row is read back.

use team_protocol::{
    identifiers::{canonical_assistant_id, canonical_identifier},
    payload::{ASSISTANT_VERSION_RE, DETAILS_CREATOR_RE},
    websocket::{HEX_ID_RE, public_text},
};

use super::Invalid;
use crate::{
    chat::assistants::install::ASSISTANT_LIMIT_REACHED,
    json::{self, Value},
};

fn creator(value: &Value) -> bool {
    DETAILS_CREATOR_RE.is_full_value(value)
}

fn version(value: &Value) -> bool {
    ASSISTANT_VERSION_RE.is_full_value(value)
}

fn status_code(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(json::as_int)
        .filter(|status| (400..=599).contains(status))
}

fn shown(value: &Value, key: &str, invalid: Invalid) -> Result<Value, Invalid> {
    let text = public_text(value.get(key).unwrap_or(&Value::Null), 80).map_err(|_| invalid)?;
    Ok(json::text(text))
}

fn providers(value: &Value, invalid: Invalid) -> Result<Value, Invalid> {
    let items = json::as_array(value)
        .filter(|items| items.len() <= 32)
        .ok_or(invalid)?;
    let canonical: Vec<&str> = items
        .iter()
        .map(|item| {
            canonical_identifier(item).ok_or(Invalid(
                "chat history Assistant install providers are invalid",
            ))
        })
        .collect::<Result<_, _>>()?;
    if !canonical.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(Invalid(
            "chat history Assistant install providers are invalid",
        ));
    }
    Ok(json::strings(canonical))
}

fn install_assistant(value: &Value) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history Assistant install item is invalid");
    let fields = [
        "id",
        "name",
        "summary",
        "creator",
        "version",
        "providers",
        "provenance",
        "status",
    ];
    if !json::has_exactly(value, &fields) {
        return Err(invalid);
    }
    let get = |key| value.get(key).unwrap_or(&Value::Null);
    let id = canonical_assistant_id(get("id")).filter(|id| json::as_str(get("id")) == Some(*id));
    let admitted = id.is_some()
        && matches!(json::as_str(get("provenance")), Some("local" | "published"))
        && matches!(
            json::as_str(get("status")),
            Some("pending" | "installed" | "failed")
        )
        && creator(get("creator"))
        && version(get("version"));
    let Some(id) = id.filter(|_| admitted) else {
        return Err(invalid);
    };
    let providers = providers(get("providers"), invalid)?;
    Ok(json::object(vec![
        ("id", json::text(id)),
        ("name", shown(value, "name", invalid)?),
        ("summary", shown(value, "summary", invalid)?),
        ("creator", get("creator").clone()),
        ("version", get("version").clone()),
        ("providers", providers),
        ("provenance", get("provenance").clone()),
        ("status", get("status").clone()),
    ]))
}

fn install_assistants(value: Option<&Value>, invalid: Invalid) -> Result<Vec<Value>, Invalid> {
    let items = value
        .and_then(json::as_array)
        .filter(|items| (1..=4).contains(&items.len()))
        .ok_or(invalid)?;
    let canonical: Vec<Value> = items
        .iter()
        .map(install_assistant)
        .collect::<Result<_, _>>()?;
    let ids: Vec<&str> = canonical
        .iter()
        .map(|item| json::get_str(item, "id").unwrap_or_default())
        .collect();
    if !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(invalid);
    }
    Ok(canonical)
}

fn all_installed(assistants: &[Value]) -> bool {
    assistants
        .iter()
        .all(|item| json::get_str(item, "status") == Some("installed"))
}

fn install_expected(event: &Value, state: &str) -> Result<Vec<&'static str>, Invalid> {
    let mut expected = vec!["type", "state", "plan_id", "team_id", "assistants"];
    match state {
        "installed" => {
            expected.push("continuation");
            if json::contains(event, "outcome") {
                expected.push("outcome");
            }
        }
        "failed" => {
            expected.push("status");
            if json::contains(event, "code") {
                expected.push("code");
            }
        }
        "stopped" => {}
        _ => {
            return Err(Invalid(
                "chat history Assistant install event is not terminal",
            ));
        }
    }
    Ok(expected)
}

fn install_result_valid(event: &Value, state: &str, assistants: &[Value]) -> Result<(), Invalid> {
    let installed_valid = matches!(
        json::get_str(event, "continuation"),
        Some("dispatch" | "none")
    ) && all_installed(assistants)
        && event
            .get("outcome")
            .is_none_or(|outcome| json::as_str(outcome) == Some("already-installed"));
    if state == "installed" && !installed_valid {
        return Err(Invalid("chat history installed result is invalid"));
    }
    let status = status_code(event.get("status"));
    let code_valid = event.get("code").is_none_or(|code| {
        status == Some(409) && json::as_str(code) == Some(ASSISTANT_LIMIT_REACHED)
    });
    if state == "failed" && (status.is_none() || !code_valid) {
        return Err(Invalid("chat history failed result is invalid"));
    }
    Ok(())
}

fn install_stored(state: &str, assistants: Vec<Value>, source: &Value) -> Value {
    let mut members = vec![
        ("kind".to_owned(), json::text("assistant-install")),
        ("state".to_owned(), json::text(state)),
        ("assistants".to_owned(), Value::Array(assistants)),
    ];
    if state == "failed" {
        members.push((
            "status".to_owned(),
            source.get("status").cloned().unwrap_or(Value::Null),
        ));
    }
    for key in ["code", "outcome"] {
        if let Some(value) = source.get(key) {
            members.push((key.to_owned(), value.clone()));
        }
    }
    Value::Object(members)
}

/// The stored form of an install plan's terminal event for `team_id`.
///
/// # Errors
///
/// Returns [`Invalid`] for an event outside the closed terminal shapes.
pub fn install_payload(event: &Value, team_id: &str) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history Assistant install event is invalid");
    if json::get_str(event, "type") != Some("assistant-install-plan") {
        return Err(invalid);
    }
    let state = json::get_str(event, "state").unwrap_or_default();
    let expected = install_expected(event, state)?;
    if !json::has_exactly(event, &expected)
        || json::get_str(event, "team_id") != Some(team_id)
        || !event
            .get("plan_id")
            .is_some_and(|id| HEX_ID_RE.is_full_value(id))
    {
        return Err(invalid);
    }
    let assistants = install_assistants(event.get("assistants"), invalid)?;
    install_result_valid(event, state, &assistants)?;
    Ok(install_stored(state, assistants, event))
}

fn uninstall_assistant(value: &Value) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history uninstall Assistant is invalid");
    if !json::has_exactly(value, &["id", "name", "version", "creator", "provenance"]) {
        return Err(invalid);
    }
    let get = |key| value.get(key).unwrap_or(&Value::Null);
    let id = canonical_assistant_id(get("id"))
        .filter(|id| json::as_str(get("id")) == Some(*id))
        .filter(|_| {
            version(get("version"))
                && creator(get("creator"))
                && matches!(json::as_str(get("provenance")), Some("local" | "published"))
        })
        .ok_or(invalid)?;
    Ok(json::object(vec![
        ("id", json::text(id)),
        ("name", shown(value, "name", invalid)?),
        ("version", get("version").clone()),
        ("creator", get("creator").clone()),
        ("provenance", get("provenance").clone()),
    ]))
}

/// The stored form of an uninstall's terminal event for `team_id` and its displayed `assistant`.
///
/// # Errors
///
/// Returns [`Invalid`] for an event outside the closed terminal shapes.
pub fn uninstall_payload(
    event: &Value,
    team_id: &str,
    assistant: &Value,
) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history uninstall event is invalid");
    if json::get_str(event, "type") != Some("assistant-uninstall") {
        return Err(invalid);
    }
    let state = json::get_str(event, "state").unwrap_or_default();
    let mut expected = vec!["type", "state", "proposal_id", "assistant_id"];
    match state {
        "uninstalled" => expected.extend(["team_id", "uninstalled"]),
        "failed" => expected.push("status"),
        "cancelled" | "expired" => {}
        _ => return Err(Invalid("chat history uninstall event is not terminal")),
    }
    let canonical = uninstall_assistant(assistant)?;
    if !json::has_exactly(event, &expected)
        || !event
            .get("proposal_id")
            .is_some_and(|id| HEX_ID_RE.is_full_value(id))
        || event.get("assistant_id") != canonical.get("id")
    {
        return Err(invalid);
    }
    let mut members = vec![
        ("kind".to_owned(), json::text("assistant-uninstall")),
        ("state".to_owned(), json::text(state)),
        ("assistant".to_owned(), canonical),
    ];
    if state == "uninstalled" {
        let uninstalled = event
            .get("uninstalled")
            .filter(|value| matches!(value, Value::Bool(_)));
        if json::get_str(event, "team_id") != Some(team_id) || uninstalled.is_none() {
            return Err(Invalid("chat history uninstall result is invalid"));
        }
        members.push((
            "uninstalled".to_owned(),
            uninstalled.cloned().unwrap_or(Value::Null),
        ));
    } else if state == "failed" {
        let status = status_code(event.get("status"))
            .ok_or(Invalid("chat history uninstall failure is invalid"))?;
        members.push(("status".to_owned(), json::int(status)));
    }
    Ok(Value::Object(members))
}

/// Re-validates a stored install row.
///
/// # Errors
///
/// Returns [`Invalid`] for a row Admin did not write.
pub fn validate_stored_install(payload: &Value) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored install");
    let state = json::get_str(payload, "state").unwrap_or_default();
    let mut expected = vec!["kind", "state", "assistants"];
    if state == "failed" {
        expected.push("status");
    }
    for key in ["outcome", "code"] {
        if json::contains(payload, key) {
            expected.push(key);
        }
    }
    if !json::has_exactly(payload, &expected)
        || !matches!(state, "installed" | "failed" | "stopped")
    {
        return Err(invalid);
    }
    let assistants = install_assistants(payload.get("assistants"), invalid)?;
    let outcome_valid = payload.get("outcome").is_none_or(|outcome| {
        state == "installed" && json::as_str(outcome) == Some("already-installed")
    });
    let code_valid = payload.get("code").is_none_or(|code| {
        state == "failed"
            && payload.get("status").and_then(json::as_int) == Some(409)
            && json::as_str(code) == Some(ASSISTANT_LIMIT_REACHED)
    });
    if (state == "installed" && !all_installed(&assistants))
        || !outcome_valid
        || (state == "failed" && status_code(payload.get("status")).is_none())
        || !code_valid
    {
        return Err(invalid);
    }
    Ok(())
}

/// Re-validates a stored uninstall row.
///
/// # Errors
///
/// Returns [`Invalid`] for a row Admin did not write.
pub fn validate_stored_uninstall(payload: &Value) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored uninstall");
    let state = json::get_str(payload, "state").unwrap_or_default();
    let mut expected = vec!["kind", "state", "assistant"];
    match state {
        "uninstalled" => expected.push("uninstalled"),
        "failed" => expected.push("status"),
        "cancelled" | "expired" => {}
        _ => return Err(invalid),
    }
    if !json::has_exactly(payload, &expected) {
        return Err(invalid);
    }
    uninstall_assistant(payload.get("assistant").unwrap_or(&Value::Null))?;
    if (state == "uninstalled" && !matches!(payload.get("uninstalled"), Some(Value::Bool(_))))
        || (state == "failed" && status_code(payload.get("status")).is_none())
    {
        return Err(invalid);
    }
    Ok(())
}
