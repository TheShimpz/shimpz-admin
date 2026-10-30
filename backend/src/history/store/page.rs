//! One newest-first page of a Team's transcript: the chat's view, or one Routine's own history.
//!
//! The chat shows the conversation, how the person answered each Routine card, and, of its Routines' notices, only
//! each Routine's creation; a Routine's own history is its runs, its healthy rollups, the runs it missed, and its pause
//! after a failure streak. Both filter the same rows, so a page's position cursor works alike in either.

use data_encoding::BASE64URL_NOPAD;
use rusqlite::params;
use team_protocol::{
    routine::{ROUTINE_ID_RE, matches},
    routine_notice::instant,
};

use super::{MAX_PAGE_BYTES, PAGE_ROWS, Store, decoded, team_id, unavailable};
use crate::{
    history::{HistoryError, Invalid},
    json::{self, Value},
};

const PAGE_SELECT: &str = "SELECT position, event_key, payload, provenance, created_at FROM transcript WHERE team_id = ? ";
const PAGE_VIEW: &str = "AND CASE WHEN ? IS NULL \
    THEN NOT (substr(event_key, -8) = ':routine' AND json_extract(payload, '$.outcome') IS NOT 'created') \
    ELSE substr(event_key, -8) = ':routine' AND json_extract(payload, '$.kind') = 'routine-run' \
    AND json_extract(payload, '$.routine_id') = ? AND (json_extract(payload, '$.run_id') IS NOT NULL \
    OR json_extract(payload, '$.outcome') IN ('healthy', 'skipped', 'streak-paused')) END ";

/// The cursor of a transcript position.
#[must_use]
pub fn cursor(position: i64) -> String {
    BASE64URL_NOPAD.encode(&position.to_be_bytes())
}

/// The position a cursor names.
///
/// # Errors
///
/// Returns [`Invalid`] for anything but a canonical cursor of a position from 1.
pub fn position(value: &str) -> Result<i64, Invalid> {
    let invalid = Invalid("chat history cursor is invalid");
    if value.is_empty() || value.len() > 16 {
        return Err(invalid);
    }
    let raw = BASE64URL_NOPAD
        .decode(value.as_bytes())
        .map_err(|_| invalid)?;
    let bytes: [u8; 8] = raw.try_into().map_err(|_| invalid)?;
    let position = i64::from_be_bytes(bytes);
    if position < 1 || cursor(position) != value {
        return Err(invalid);
    }
    Ok(position)
}

/// One row as the page shows it.
fn entry(
    event_key: &str,
    raw: &str,
    provenance: &str,
    created_at: &str,
) -> Result<Value, HistoryError> {
    let payload = decoded(raw)?;
    if !instant(&json::text(created_at)) {
        return Err(HistoryError::Unavailable);
    }
    if json::get_str(&payload, "role") == Some("user")
        && json::contains(&payload, "files") != (provenance == "attached")
    {
        return Err(HistoryError::Unavailable);
    }
    if json::get_str(&payload, "kind") == Some("routine-run")
        && json::get_str(&payload, "created_at") != Some(created_at)
    {
        return Err(HistoryError::Unavailable);
    }
    let mut members = vec![("id".to_owned(), json::text(event_key))];
    members.extend(json::members(&payload).unwrap_or_default().iter().cloned());
    let mut shown = Value::Object(members);
    json::set(&mut shown, "created_at", json::text(created_at));
    Ok(shown)
}

/// The newest rows of the view before `before`, one at a time within the row and byte bounds.
fn collect(
    database: &rusqlite::Transaction<'_>,
    team: &str,
    before: Option<i64>,
    routine: Option<&str>,
) -> Result<Collected, HistoryError> {
    let limit = i64::try_from(PAGE_ROWS + 1).unwrap_or(i64::MAX);
    let mut collected = Collected {
        selected: Vec::new(),
        older: false,
    };
    let order = if before.is_some() {
        "AND position < ? ORDER BY position DESC LIMIT ?"
    } else {
        "ORDER BY position DESC LIMIT ?"
    };
    let mut statement = database
        .prepare(&format!("{PAGE_SELECT}{PAGE_VIEW}{order}"))
        .map_err(unavailable)?;
    let mut rows = match before {
        Some(before) => statement.query(params![team, routine, routine, before, limit]),
        None => statement.query(params![team, routine, routine, limit]),
    }
    .map_err(unavailable)?;
    let mut size = 0;
    while let Some(row) = rows.next().map_err(unavailable)? {
        if collected.selected.len() == PAGE_ROWS {
            collected.older = true;
            break;
        }
        let text = |index| row.get::<_, String>(index).map_err(unavailable);
        let (key, raw, provenance, created) = (text(1)?, text(2)?, text(3)?, text(4)?);
        let shown = entry(&key, &raw, &provenance, &created)?;
        let entry_size = raw.len() + key.len() + created.len();
        if !collected.selected.is_empty() && size + entry_size > MAX_PAGE_BYTES {
            collected.older = true;
            break;
        }
        collected
            .selected
            .push((row.get(0).map_err(unavailable)?, shown));
        size += entry_size;
    }
    Ok(collected)
}

struct Collected {
    selected: Vec<(i64, Value)>,
    older: bool,
}

impl Store {
    /// One newest-first page, fetching rows one at a time so the byte cap bounds the memory it holds; the one-row
    /// lookahead that would exceed a bound proves an older entry exists and keeps the older-history cursor.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError::Invalid`] for an invalid Team id, cursor, or Routine id, and
    /// [`HistoryError::Unavailable`] when the store cannot be read.
    pub fn page(
        &self,
        team: &str,
        before: Option<&str>,
        routine: Option<&str>,
    ) -> Result<Value, HistoryError> {
        let team = team_id(team)?;
        let before = before.map(position).transpose()?;
        if routine.is_some_and(|routine| !matches(&json::text(routine), &ROUTINE_ID_RE)) {
            return Err(Invalid("chat history Routine id is invalid").into());
        }
        let collected = self.database(|database| collect(database, &team, before, routine))?;
        let Some((oldest, _)) = collected.selected.last() else {
            return Ok(json::object(vec![
                ("entries", Value::Array(Vec::new())),
                ("before", Value::Null),
            ]));
        };
        let before = if collected.older {
            json::text(cursor(*oldest))
        } else {
            Value::Null
        };
        let entries = collected
            .selected
            .into_iter()
            .rev()
            .map(|(_, entry)| entry)
            .collect();
        Ok(json::object(vec![
            ("entries", Value::Array(entries)),
            ("before", before),
        ]))
    }
}
