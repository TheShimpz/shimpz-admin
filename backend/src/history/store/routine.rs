//! The Routine rows of a transcript: each run's notice (ADR-0086) and how the person answered a card (ADR-0101).

use rusqlite::{OptionalExtension, params};
use team_protocol::{
    routine_notice::canonical_notice, routine_proposal::canonical_proposal_answer,
};

use super::{
    CARD_BY_PROPOSAL, NOTICE_FIELDS, STORED_OUTCOMES, Store, decoded, encoded, payload_at, team_id,
    unavailable,
};
use crate::{
    history::{HistoryError, Invalid},
    json::{self, Value},
};

impl Store {
    /// Writes one Routine notice to its Team's transcript (ADR-0086); it never enters the Brain window. A run keeps one
    /// row; a newer version replaces it and moves it to the end; a notice no view shows is stored nowhere.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_routine_notice(&self, notice: &Value) -> Result<bool, HistoryError> {
        let admitted = canonical_notice(notice).ok_or(Invalid("Routine notice is invalid"))?;
        let team = team_id(json::get_str(admitted, "team_id").unwrap_or_default())?;
        let outcome = json::get_str(admitted, "outcome").unwrap_or_default();
        if !STORED_OUTCOMES.contains(&outcome) {
            return Ok(true);
        }
        let event_key = format!(
            "{}:routine",
            json::get_str(admitted, "notice_id").unwrap_or_default()
        );
        let payload = notice_payload(admitted);
        let encoded = encoded(&payload)?;
        let version = json::get(&payload, "version")
            .and_then(json::as_int)
            .unwrap_or_default();
        let created_at = json::get_str(admitted, "created_at")
            .unwrap_or_default()
            .to_owned();
        let written = self.database(|database| {
            write_notice(database, &team, &event_key, &encoded, &created_at, version)
        })?;
        match written {
            NoticeWrite::Delivered(same) => Ok(same),
            NoticeWrite::Written => {
                self.changed(&team);
                Ok(true)
            }
        }
    }

    /// Writes how the person answered a Routine card (ADR-0101), once; a card the transcript no longer holds writes
    /// nothing.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn append_proposal_answer(&self, answer: &Value) -> Result<bool, HistoryError> {
        let admitted =
            canonical_proposal_answer(answer).ok_or(Invalid("Routine card answer is invalid"))?;
        let team = team_id(json::get_str(admitted, "team_id").unwrap_or_default())?;
        let proposal_id = json::get_str(admitted, "proposal_id")
            .unwrap_or_default()
            .to_owned();
        let status = admitted.get("status").cloned().unwrap_or(Value::Null);
        let now = self.now();
        let inserted = self.database(|database| {
            let found: Option<Option<String>> = database
                .query_row(CARD_BY_PROPOSAL, params![team, proposal_id], |row| row.get(0))
                .optional()
                .map_err(unavailable)?;
            let Some(name) = found else {
                return Ok(None);
            };
            let payload = json::object(vec![
                ("kind", json::text("routine-answer")),
                ("proposal_id", json::text(&proposal_id)),
                ("status", status.clone()),
                ("name", name.map_or(Value::Null, json::text)),
            ]);
            let changed = database
                .execute(
                    "INSERT OR IGNORE INTO transcript (team_id, event_key, payload, provenance, created_at) \
                     VALUES (?, ?, ?, 'plain', ?)",
                    params![team, format!("{proposal_id}:answer"), encoded(&payload)?, now],
                )
                .map_err(unavailable)?;
            Ok(Some(changed == 1))
        })?;
        match inserted {
            None => Ok(false),
            Some(changed) => {
                if changed {
                    self.changed(&team);
                }
                Ok(true)
            }
        }
    }
}

/// What one Routine notice write did.
enum NoticeWrite {
    /// The run's row already holds this or a newer version: whether it holds exactly this one.
    Delivered(bool),
    /// The notice was written.
    Written,
}

/// The stored row of a notice a view shows.
fn notice_payload(admitted: &Value) -> Value {
    let mut members = vec![("kind", json::text("routine-run"))];
    members.extend(
        NOTICE_FIELDS
            .iter()
            .map(|name| (*name, admitted.get(name).cloned().unwrap_or(Value::Null))),
    );
    json::object(members)
}

/// Writes one notice row unless the run's row already holds this or a newer version.
fn write_notice(
    database: &rusqlite::Transaction<'_>,
    team: &str,
    event_key: &str,
    encoded: &str,
    created_at: &str,
    version: i64,
) -> Result<NoticeWrite, HistoryError> {
    if let Some(existing) = payload_at(database, team, event_key)? {
        let stored = decoded(&existing)?;
        let stored_version = json::get(&stored, "version")
            .and_then(json::as_int)
            .unwrap_or_default();
        if stored_version > version {
            return Ok(NoticeWrite::Delivered(true));
        }
        if stored_version == version {
            return Ok(NoticeWrite::Delivered(existing == encoded));
        }
        database
            .execute(
                "DELETE FROM transcript WHERE team_id = ? AND event_key = ?",
                params![team, event_key],
            )
            .map_err(unavailable)?;
    }
    database
        .execute(
            "INSERT INTO transcript (team_id, event_key, payload, provenance, created_at) VALUES (?, ?, ?, 'plain', ?)",
            params![team, event_key, encoded, created_at],
        )
        .map_err(unavailable)?;
    Ok(NoticeWrite::Written)
}
