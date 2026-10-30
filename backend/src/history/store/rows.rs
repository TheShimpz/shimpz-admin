//! The rows of one chat turn: the person's message, then exactly one of its endings.

use team_protocol::{
    payload::{
        MAX_TEAM_NAME_CHARS, canonical_clarification, canonical_turn_usage, render_clarification,
    },
    turn::MAX_CHAT_MESSAGE_CHARS,
    websocket::public_text,
};

use super::{
    GUIDANCE_CODES, MAX_STATUS_DETAIL_CHARS, Row, Store, encoded, team_id, turn_id, validate,
};
use crate::{
    chat::local::BROWSER_FIELD,
    history::{HistoryError, Invalid, lifecycle, reply},
    json::{self, Value},
};

impl Store {
    /// Admits one user message with the files it carried; files mark its whole turn `attached` (ADR-0093).
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_user(
        &self,
        team: &str,
        turn: &str,
        message: &Value,
        files: &[Value],
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        let text = validate::chat_text(
            message,
            MAX_CHAT_MESSAGE_CHARS,
            Invalid("chat history user message is invalid"),
        )?;
        let mut members = vec![
            ("kind", json::text("message")),
            ("role", json::text("user")),
            ("text", json::text(text)),
        ];
        if !files.is_empty() {
            members.push((
                "files",
                Value::Array(validate::file_references(&Value::Array(files.to_vec()))?),
            ));
        }
        let payload = json::object(members);
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:user"),
            payload: &payload,
            anchor: None,
            finish: None,
            attached: !files.is_empty(),
        })
    }

    /// Keeps one turn's reply, with what it carried and the receipt of the steps its page was shown.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_reply(
        &self,
        team: &str,
        turn: &str,
        event: &Value,
        receipt: Option<&Value>,
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        let entry = reply_entry(&team, event, receipt)?;
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:reply"),
            payload: &entry,
            anchor: Some(&turn),
            finish: Some(&turn),
            attached: false,
        })
    }

    /// Keeps an install plan's terminal outcome.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_install(
        &self,
        team: &str,
        turn: &str,
        event: &Value,
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        let payload = lifecycle::install_payload(event, &team)?;
        let finished = json::get_str(&payload, "state") != Some("installed")
            || json::get_str(event, "continuation") == Some("none");
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:install"),
            payload: &payload,
            anchor: Some(&turn),
            finish: finished.then_some(turn.as_str()),
            attached: false,
        })
    }

    /// Keeps how one turn ended without a reply; `finish` also ends its resumable state.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_status(
        &self,
        team: &str,
        turn: &str,
        event: &Value,
        finish: bool,
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        let payload = status_payload(event)?;
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:status"),
            payload: &payload,
            anchor: Some(&turn),
            finish: finish.then_some(turn.as_str()),
            attached: false,
        })
    }

    /// Keeps one turn's lifecycle guidance.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_guidance(
        &self,
        team: &str,
        turn: &str,
        code: &str,
        reply: &str,
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        if !GUIDANCE_CODES.contains(&code) {
            return Err(Invalid("chat history guidance is invalid").into());
        }
        let text = validate::chat_text(
            &json::text(reply),
            validate::MAX_GUIDANCE_REPLY_CHARS,
            Invalid("chat history guidance reply is invalid"),
        )?;
        let payload = json::object(vec![
            ("kind", json::text("guidance")),
            ("code", json::text(code)),
            ("reply", json::text(text)),
        ]);
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:guidance"),
            payload: &payload,
            anchor: Some(&turn),
            finish: Some(&turn),
            attached: false,
        })
    }

    /// Keeps an uninstall's terminal outcome beside its displayed Assistant.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_uninstall(
        &self,
        team: &str,
        turn: &str,
        assistant: &Value,
        event: &Value,
    ) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        let payload = lifecycle::uninstall_payload(event, &team, assistant)?;
        self.append(&Row {
            team_id: &team,
            event_key: format!("{turn}:uninstall"),
            payload: &payload,
            anchor: Some(&turn),
            finish: Some(&turn),
            attached: false,
        })
    }
}

/// Whether `event` is a done event of `team` with exactly its public fields.
fn done_shape(event: &Value, team: &str) -> bool {
    let mut required: Vec<&str> = json::members(event)
        .unwrap_or_default()
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| !crate::chat::local::fields::OPTIONAL_DONE_FIELDS.contains(name))
        .collect();
    required.sort_unstable();
    json::members(event).is_some()
        && required == ["clarification", "reply", "team_id", "team_name", "type"]
        && json::get_str(event, "type") == Some("done")
        && json::get_str(event, "team_id") == Some(team)
}

/// A reply's admitted clarification, usage, and Browser files.
fn reply_extras(event: &Value, reply: &str) -> Result<Vec<(String, Value)>, Invalid> {
    let invalid = Invalid("chat history reply event is invalid");
    let mut members = Vec::new();
    let clarification = event.get("clarification").unwrap_or(&Value::Null);
    if *clarification != Value::Null {
        let canonical = canonical_clarification(clarification).ok_or(invalid)?;
        if reply != render_clarification(&canonical) {
            return Err(invalid);
        }
        members.push(("clarification".to_owned(), canonical));
    }
    if let Some(usage) = event.get("usage") {
        members.push((
            "usage".to_owned(),
            canonical_turn_usage(usage).ok_or(invalid)?,
        ));
    }
    if let Some(browser) = event.get(BROWSER_FIELD) {
        let canonical = team_protocol::browser::canonical_terminal(browser).ok_or(invalid)?;
        members.push((BROWSER_FIELD.to_owned(), canonical));
    }
    Ok(members)
}

fn reply_entry(team: &str, event: &Value, receipt: Option<&Value>) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history reply event is invalid");
    if !done_shape(event, team) {
        return Err(invalid);
    }
    let get = |key| event.get(key).unwrap_or(&Value::Null);
    let author = public_text(get("team_name"), MAX_TEAM_NAME_CHARS).map_err(|_| invalid)?;
    let reply = validate::reply_text(get("reply"), event)?;
    let mut members = vec![
        ("kind".to_owned(), json::text("message")),
        ("role".to_owned(), json::text("assistant")),
        ("text".to_owned(), json::text(&reply)),
        ("author".to_owned(), json::text(author)),
    ];
    members.extend(reply_extras(event, &reply)?);
    let stored_clarification = members
        .iter()
        .find(|(name, _)| name == "clarification")
        .map_or(Value::Null, |(_, value)| value.clone());
    members.extend(reply::routine_reply(event, &stored_clarification)?);
    let mut entry = Value::Object(members);
    if let Some(receipt) = receipt {
        json::set(
            &mut entry,
            "receipt",
            Value::Array(reply::receipt(receipt)?),
        );
        if encoded(&entry).is_err() {
            json::remove(&mut entry, "receipt");
        }
    }
    Ok(entry)
}

fn status_payload(event: &Value) -> Result<Value, Invalid> {
    let invalid = Invalid("chat history status is invalid");
    if json::get_str(event, "type") == Some("stopped") && json::has_exactly(event, &["type"]) {
        return Ok(json::object(vec![
            ("kind", json::text("status")),
            ("state", json::text("stopped")),
        ]));
    }
    if json::get_str(event, "type") == Some("error")
        && json::has_exactly(event, &["type", "status", "detail"])
    {
        let payload = json::object(vec![
            ("kind", json::text("status")),
            ("state", json::text("failed")),
            (
                "status",
                event.get("status").cloned().unwrap_or(Value::Null),
            ),
            (
                "detail",
                json::text(status_detail(event.get("detail").unwrap_or(&Value::Null))),
            ),
        ]);
        validate::status(&payload)?;
        return Ok(payload);
    }
    Err(invalid)
}

/// The detail the page was shown, on one line within its bound, or a plain one when it is not public text.
fn status_detail(detail: &Value) -> String {
    if let Some(detail) = json::as_str(detail) {
        let words: Vec<&str> = detail
            .split(team_protocol::python::text::isspace)
            .filter(|word| !word.is_empty())
            .collect();
        let line: String = words
            .join(" ")
            .chars()
            .take(MAX_STATUS_DETAIL_CHARS)
            .collect();
        let line = team_protocol::python::text::strip(&line).to_owned();
        if public_text(&json::text(&line), MAX_STATUS_DETAIL_CHARS).is_ok() {
            return line;
        }
    }
    "the turn failed".to_owned()
}
