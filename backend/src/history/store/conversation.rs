//! The bounded conversation window a turn carries: the latest plain same-Team entries before its message.

use rusqlite::{OptionalExtension, params};

use super::{CONVERSATION_QUERY, Store, decoded, team_id, turn_id, unavailable};
use crate::{
    chat::local::BROWSER_FIELD,
    history::{HistoryError, context},
    json::{self, Value},
};

impl Store {
    /// The latest eligible same-Team entries before one exact admitted user turn.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn conversation(
        &self,
        team: &str,
        before_turn: &str,
    ) -> Result<Vec<context::Entry>, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(before_turn)?;
        let rows = self.database(|database| {
            let anchor: Option<(i64, String)> = database
                .query_row(
                    "SELECT position, payload FROM transcript WHERE team_id = ? AND event_key = ?",
                    params![team, format!("{turn}:user")],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(unavailable)?;
            let (position, payload) = anchor.ok_or(HistoryError::Unavailable)?;
            let payload = decoded(&payload)?;
            if json::get_str(&payload, "kind") != Some("message")
                || json::get_str(&payload, "role") != Some("user")
            {
                return Err(HistoryError::Unavailable);
            }
            let mut statement = database.prepare(CONVERSATION_QUERY).map_err(unavailable)?;
            let limit = i64::try_from(context::MAX_ENTRIES).unwrap_or(i64::MAX);
            let rows = statement
                .query_map(params![team, position, limit], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(unavailable)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(unavailable)?;
            Ok(rows)
        })?;
        project_conversation(rows)
    }
}

fn conversation_entry(
    event_key: &str,
    payload: &Value,
) -> Result<Option<context::Entry>, HistoryError> {
    let (turn, suffix) = event_key
        .rsplit_once(':')
        .ok_or(HistoryError::Unavailable)?;
    turn_id(turn).map_err(|_| HistoryError::Unavailable)?;
    let kind = json::get_str(payload, "kind");
    let role = json::get_str(payload, "role");
    let (role, text) = match suffix {
        "user"
            if kind == Some("message")
                && role == Some("user")
                && !json::contains(payload, "files") =>
        {
            ("user", payload.get("text"))
        }
        "reply" if kind == Some("message") && role == Some("assistant") => {
            ("assistant", payload.get("text"))
        }
        "guidance" if kind == Some("guidance") => ("assistant", payload.get("reply")),
        _ => return Err(HistoryError::Unavailable),
    };
    Ok(text
        .and_then(json::as_str)
        .and_then(|text| context::bounded(role, text).ok()))
}

fn project_conversation(rows: Vec<(String, String)>) -> Result<Vec<context::Entry>, HistoryError> {
    let decoded: Vec<(String, Value)> = rows
        .into_iter()
        .rev()
        .map(|(key, raw)| decoded(&raw).map(|payload| (key, payload)))
        .collect::<Result<_, _>>()?;
    let browser_turns: Vec<&str> = decoded
        .iter()
        .filter(|(key, payload)| key.ends_with(":reply") && json::contains(payload, BROWSER_FIELD))
        .map(|(key, _)| key.rsplit_once(':').map_or("", |(turn, _)| turn))
        .collect();
    let mut entries = Vec::new();
    for (key, payload) in &decoded {
        let turn = key.rsplit_once(':').map_or("", |(turn, _)| turn);
        if browser_turns.contains(&turn) {
            continue;
        }
        if let Some(entry) = conversation_entry(key, payload)? {
            entries.push(entry);
        }
    }
    Ok(entries)
}
