//! The closed shapes of stored transcript rows, checked when a row is written and again when it is read back.

use team_protocol::{
    browser::canonical_terminal,
    payload::{
        MAX_CHAT_FILES, MAX_FILE_UPLOAD_BYTES, MAX_TEAM_NAME_CHARS, canonical_clarification,
        canonical_file_id, canonical_filename, canonical_media_type, canonical_turn_usage,
        render_clarification,
    },
    python::text,
    routine::{ROUTINE_ID_RE, ROUTINE_OUTCOMES, exact_name, matches},
    routine_notice::{canonical_notice_detail, instant, notice_usage},
    routine_proposal::PROPOSAL_STATUSES,
    turn::{
        MAX_CHAT_MESSAGE_CHARS, MAX_INTENT_ROUTE_REPLY_CHARS, MAX_REPLY_CHARS, REPLY_CONTROL_RE,
    },
    websocket::public_text,
};

use super::{
    FILE_REFERENCE_KEYS, GUIDANCE_CODES, MAX_STATUS_DETAIL_CHARS, NOTICE_FIELDS, STORED_OUTCOMES,
};
use crate::{
    chat::local::{BROWSER_FIELD, ROUTINE_FIELDS},
    history::{Invalid, lifecycle, reply},
    json::{self, Value},
};

/// Stored chat text: trimmed, within its bound, and free of the control characters a Team reply never carries.
pub(super) fn chat_text(
    value: &Value,
    maximum: usize,
    invalid: Invalid,
) -> Result<String, Invalid> {
    let text = json::as_str(value).ok_or(invalid)?;
    if text.is_empty()
        || text::strip(text) != text
        || text::len(text) > maximum
        || !REPLY_CONTROL_RE.is_absent(text)
    {
        return Err(invalid);
    }
    Ok(text.to_owned())
}

/// A reply's text, which is empty only beside a Routine card, question, or refusal that says everything.
pub(super) fn reply_text(value: &Value, carrier: &Value) -> Result<String, Invalid> {
    if json::as_str(value) == Some("")
        && ROUTINE_FIELDS
            .iter()
            .any(|name| json::contains(carrier, name))
    {
        return Ok(String::new());
    }
    chat_text(
        value,
        MAX_REPLY_CHARS,
        Invalid("chat history assistant reply is invalid"),
    )
}

/// The guidance reply's bound.
pub(super) const MAX_GUIDANCE_REPLY_CHARS: usize = MAX_INTENT_ROUTE_REPLY_CHARS;

fn file_reference(value: &Value) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history file reference is invalid");
    if !json::has_exactly(value, &FILE_REFERENCE_KEYS) {
        return Err(invalid);
    }
    let get = |key| value.get(key).unwrap_or(&Value::Null);
    let name = get("name");
    let media_type = get("media_type");
    let valid = canonical_file_id(get("id")).is_some()
        && json::as_str(name)
            .is_some_and(|name| canonical_filename(&json::text(name)) == Some(name))
        && json::as_str(media_type).is_some_and(|media| {
            canonical_media_type(&json::text(media)).as_deref() == Some(media)
        })
        && json::as_int(get("size"))
            .is_some_and(|size| (1..=MAX_FILE_UPLOAD_BYTES).contains(&size));
    if !valid {
        return Err(invalid);
    }
    Ok(json::object(
        FILE_REFERENCE_KEYS
            .iter()
            .map(|key| (*key, get(key).clone()))
            .collect(),
    ))
}

/// The files one user message carried, as the transcript shows them.
pub(super) fn file_references(value: &Value) -> Result<Vec<Value>, Invalid> {
    let invalid = Invalid("chat history file references are invalid");
    let items = json::as_array(value)
        .filter(|items| (1..=MAX_CHAT_FILES).contains(&items.len()))
        .ok_or(invalid)?;
    let references: Vec<Value> = items.iter().map(file_reference).collect::<Result<_, _>>()?;
    let mut ids: Vec<&str> = references
        .iter()
        .filter_map(|item| json::get_str(item, "id"))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != references.len() {
        return Err(invalid);
    }
    Ok(references)
}

fn assistant_extras(payload: &Value, expected: &mut Vec<String>) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored message");
    expected.push("author".to_owned());
    if let Some(clarification) = payload.get("clarification") {
        expected.push("clarification".to_owned());
        let canonical = canonical_clarification(clarification).ok_or(invalid)?;
        if !json::equal(&canonical, clarification)
            || json::get_str(payload, "text") != Some(render_clarification(&canonical).as_str())
        {
            return Err(invalid);
        }
    }
    if let Some(usage) = payload.get("usage") {
        expected.push("usage".to_owned());
        if !canonical_turn_usage(usage).is_some_and(|canonical| json::equal(&canonical, usage)) {
            return Err(invalid);
        }
    }
    if let Some(receipt) = payload.get("receipt") {
        expected.push("receipt".to_owned());
        reply::receipt(receipt)?;
    }
    if let Some(browser) = payload.get(BROWSER_FIELD) {
        expected.push(BROWSER_FIELD.to_owned());
        if !canonical_terminal(browser).is_some_and(|canonical| json::equal(&canonical, browser)) {
            return Err(invalid);
        }
    }
    let clarification = payload.get("clarification").unwrap_or(&Value::Null);
    expected.extend(
        reply::routine_reply(payload, clarification)?
            .into_iter()
            .map(|(name, _)| name),
    );
    Ok(())
}

fn message(payload: &Value) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored message");
    let role = json::get_str(payload, "role").unwrap_or_default();
    let mut expected: Vec<String> = ["kind", "role", "text"].map(str::to_owned).to_vec();
    if role == "assistant" {
        assistant_extras(payload, &mut expected)?;
    }
    if role == "user" && json::contains(payload, "files") {
        expected.push("files".to_owned());
        file_references(payload.get("files").unwrap_or(&Value::Null))?;
    }
    let names: Vec<&str> = expected.iter().map(String::as_str).collect();
    if !json::has_exactly(payload, &names) || !matches!(role, "user" | "assistant") {
        return Err(invalid);
    }
    let text = payload.get("text").unwrap_or(&Value::Null);
    if role == "user" {
        chat_text(
            text,
            MAX_CHAT_MESSAGE_CHARS,
            Invalid("chat history stored message is invalid"),
        )?;
    } else {
        reply_text(text, payload)?;
        public_text(
            payload.get("author").unwrap_or(&Value::Null),
            MAX_TEAM_NAME_CHARS,
        )
        .map_err(|_| invalid)?;
    }
    Ok(())
}

fn guidance(payload: &Value) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored guidance");
    if !json::has_exactly(payload, &["kind", "code", "reply"])
        || !json::get_str(payload, "code").is_some_and(|code| GUIDANCE_CODES.contains(&code))
    {
        return Err(invalid);
    }
    chat_text(
        payload.get("reply").unwrap_or(&Value::Null),
        MAX_GUIDANCE_REPLY_CHARS,
        invalid,
    )?;
    Ok(())
}

/// Re-validates a stored ending without a reply.
pub(super) fn status(payload: &Value) -> Result<(), Invalid> {
    let invalid = Invalid("invalid stored status");
    if json::get_str(payload, "state") == Some("stopped")
        && json::has_exactly(payload, &["kind", "state"])
    {
        return Ok(());
    }
    let status = payload.get("status").and_then(json::as_int);
    if json::get_str(payload, "state") != Some("failed")
        || !json::has_exactly(payload, &["kind", "state", "status", "detail"])
        || !status.is_some_and(|status| (400..=599).contains(&status))
    {
        return Err(invalid);
    }
    public_text(
        payload.get("detail").unwrap_or(&Value::Null),
        MAX_STATUS_DETAIL_CHARS,
    )
    .map_err(|_| invalid)?;
    Ok(())
}

fn routine_run(payload: &Value) -> Result<(), Invalid> {
    let mut fields = vec!["kind"];
    fields.extend(NOTICE_FIELDS);
    if !json::has_exactly(payload, &fields) {
        return Err(Invalid("invalid stored Routine notice"));
    }
    let get = |key| payload.get(key).unwrap_or(&Value::Null);
    let outcome = get("outcome");
    let outcome_text = json::as_str(outcome).unwrap_or_default();
    let routine_outcome = ROUTINE_OUTCOMES.contains(&outcome_text);
    let expected_run = if routine_outcome {
        Value::Null
    } else {
        get("notice_id").clone()
    };
    let protection = get("protection_lost");
    let valid = STORED_OUTCOMES.contains(&outcome_text)
        && canonical_notice_detail(outcome, get("detail"))
            .is_some_and(|detail| json::equal(detail, get("detail")))
        && matches(get("notice_id"), &ROUTINE_ID_RE)
        && json::as_int(get("version")).is_some_and(|version| version >= 1)
        && matches(get("routine_id"), &ROUTINE_ID_RE)
        && exact_name(get("name"))
        && json::equal(get("run_id"), &expected_run)
        && instant(get("created_at"))
        && notice_usage(outcome, get("usage"))
        && matches!(protection, Value::Bool(_))
        && !(routine_outcome && *protection == Value::Bool(true));
    if valid {
        Ok(())
    } else {
        Err(Invalid("invalid stored Routine notice"))
    }
}

fn routine_answer(payload: &Value) -> Result<(), Invalid> {
    let valid = json::has_exactly(payload, &["kind", "proposal_id", "status", "name"])
        && matches(
            payload.get("proposal_id").unwrap_or(&Value::Null),
            &ROUTINE_ID_RE,
        )
        && json::get_str(payload, "status")
            .is_some_and(|status| PROPOSAL_STATUSES.contains(&status))
        && exact_name(payload.get("name").unwrap_or(&Value::Null));
    if valid {
        Ok(())
    } else {
        Err(Invalid("invalid stored Routine card answer"))
    }
}

/// The kinds a transcript row may be.
pub(super) const KINDS: [&str; 7] = [
    "message",
    "assistant-install",
    "assistant-uninstall",
    "guidance",
    "status",
    "routine-run",
    "routine-answer",
];

/// Re-validates one stored payload of a known kind.
pub(super) fn payload(payload: &Value) -> Result<(), Invalid> {
    match json::get_str(payload, "kind").unwrap_or_default() {
        "routine-run" => routine_run(payload),
        "routine-answer" => routine_answer(payload),
        "message" => message(payload),
        "assistant-install" => lifecycle::validate_stored_install(payload),
        "assistant-uninstall" => lifecycle::validate_stored_uninstall(payload),
        "guidance" => guidance(payload),
        _ => status(payload),
    }
}
