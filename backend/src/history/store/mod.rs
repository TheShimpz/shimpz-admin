//! The durable Local Admin chat history (`chat-history.sqlite3`, schema 15) and its bounded conversation projection.
//!
//! Every row is one closed payload written once under its Team and event key; a turn's later rows need its user row in
//! the same transaction, so a Team deletion or Space reset that cleared the transcript is never undone by a delayed
//! reply. A row's provenance is server-owned: `attached` marks every row of a turn whose message carried files, which
//! never enters a conversation projection (ADR-0093).

mod conversation;
mod page;
mod routine;
mod rows;
mod validate;

use std::{
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use team_protocol::{identifiers::canonical_team_id, websocket::HEX_ID_RE};

use super::{HistoryError, Invalid};
use crate::{
    json::{self, Value},
    session::topics::Topics,
    sync::lock,
    time::clock::Clock,
};

/// Version 15 keeps each Routine creation with what its recording spent.
pub const SCHEMA_VERSION: i64 = 15;
/// What the transcript shows of each file a message carried.
pub const FILE_REFERENCE_KEYS: [&str; 4] = ["id", "name", "media_type", "size"];
/// The most rows one page holds.
pub const PAGE_ROWS: usize = 64;
/// The most bytes one page holds.
pub const MAX_PAGE_BYTES: usize = 512 * 1024;
/// The largest row.
pub const MAX_ENTRY_BYTES: usize = 256 * 1024;
/// The longest detail a failed turn keeps.
pub const MAX_STATUS_DETAIL_CHARS: usize = 200;
const GUIDANCE_CODES: [&str; 6] = [
    "assistant-install-target-required",
    "assistant-uninstall-target-required",
    "assistant-lifecycle-ambiguous",
    "assistant-lifecycle-attachments",
    "assistant-capability-attachments",
    "assistant-uninstall-replacement",
];
const NOTICE_FIELDS: [&str; 10] = [
    "notice_id",
    "routine_id",
    "name",
    "run_id",
    "outcome",
    "created_at",
    "detail",
    "version",
    "usage",
    "protection_lost",
];
/// The Routine notices a view shows; any other is acknowledged and stored nowhere.
const STORED_OUTCOMES: [&str; 13] = [
    "done",
    "recovered",
    "held",
    "paused",
    "user-skipped",
    "skipped",
    "healthy",
    "frozen",
    "failed",
    "denied",
    "stopped",
    "created",
    "streak-paused",
];
const SCHEMA: &str = "
    CREATE TABLE transcript (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('plain', 'attached')),
        created_at TEXT NOT NULL,
        UNIQUE (team_id, event_key)
    );
    CREATE INDEX transcript_team_position ON transcript (team_id, position);
    CREATE INDEX transcript_team_conversation ON transcript (team_id, position)
        WHERE provenance = 'plain' AND (substr(event_key, -5) = ':user' OR substr(event_key, -6) = ':reply'
        OR substr(event_key, -9) = ':guidance');
    CREATE TABLE resumable_turn (
        team_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL UNIQUE
    );
    PRAGMA user_version = 15;
";
/// A recording's card or a refinement's card, whichever the reply carried (ADR-0122).
const CARD_BY_PROPOSAL: &str = "SELECT coalesce(json_extract(payload, '$.routine_proposal.name'), \
    json_extract(payload, '$.routine_refinement.name')) \
    FROM transcript WHERE team_id = ? AND substr(event_key, -6) = ':reply' \
    AND coalesce(json_extract(payload, '$.routine_proposal.proposal_id'), \
    json_extract(payload, '$.routine_refinement.proposal_id')) = ?";
/// The conversation projection's eligibility, exactly the partial index `transcript_team_conversation`.
const CONVERSATION_QUERY: &str = "SELECT event_key, payload FROM transcript \
    WHERE team_id = ? AND position < ? AND provenance = 'plain' AND \
    (substr(event_key, -5) = ':user' OR substr(event_key, -6) = ':reply' \
    OR substr(event_key, -9) = ':guidance') \
    ORDER BY position DESC LIMIT ?";

/// Where a row goes and how it binds to its turn.
struct Row<'a> {
    team_id: &'a str,
    event_key: String,
    payload: &'a Value,
    anchor: Option<&'a str>,
    finish: Option<&'a str>,
    attached: bool,
}

fn unavailable<E>(_: E) -> HistoryError {
    HistoryError::Unavailable
}

/// One optional text column of one row.
fn text_row(
    database: &Transaction<'_>,
    sql: &str,
    values: impl rusqlite::Params,
) -> Result<Option<String>, HistoryError> {
    database
        .query_row(sql, values, |row| row.get(0))
        .optional()
        .map_err(unavailable)
}

/// The stored payload of one Team's row.
fn payload_at(
    database: &Transaction<'_>,
    team: &str,
    event_key: &str,
) -> Result<Option<String>, HistoryError> {
    text_row(
        database,
        "SELECT payload FROM transcript WHERE team_id = ? AND event_key = ?",
        params![team, event_key],
    )
}

/// The canonical Team id of a row.
///
/// # Errors
///
/// Returns [`Invalid`] for any other value.
pub fn team_id(value: &str) -> Result<String, Invalid> {
    canonical_team_id(&json::text(value))
        .filter(|canonical| *canonical == value)
        .map(str::to_owned)
        .ok_or(Invalid("chat history Team id is invalid"))
}

/// The canonical turn id of a row.
///
/// # Errors
///
/// Returns [`Invalid`] for any other value.
pub fn turn_id(value: &str) -> Result<String, Invalid> {
    if HEX_ID_RE.is_full(value) {
        Ok(value.to_owned())
    } else {
        Err(Invalid("chat history turn id is invalid"))
    }
}

fn encoded(payload: &Value) -> Result<String, Invalid> {
    let text = json::dumps(payload, json::SORTED);
    if text.len() > MAX_ENTRY_BYTES {
        return Err(Invalid("chat history entry is too large"));
    }
    Ok(text)
}

/// One stored row's payload, read back under its closed shape.
fn decoded(raw: &str) -> Result<Value, HistoryError> {
    if raw.len() > MAX_ENTRY_BYTES {
        return Err(HistoryError::Unavailable);
    }
    let payload = json::parse(raw.as_bytes()).map_err(unavailable)?;
    let kind = json::get_str(&payload, "kind").unwrap_or_default();
    if json::members(&payload).is_none() || !validate::KINDS.contains(&kind) {
        return Err(HistoryError::Unavailable);
    }
    validate::payload(&payload).map_err(unavailable)?;
    Ok(payload)
}

fn initialize(database: &Connection) -> Result<(), HistoryError> {
    for (name, value) in [
        ("trusted_schema", "OFF"),
        ("secure_delete", "ON"),
        ("journal_mode", "DELETE"),
        ("synchronous", "FULL"),
    ] {
        database
            .pragma_update(None, name, value)
            .map_err(unavailable)?;
    }
    let version: i64 = database
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(unavailable)?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    if version != 0 {
        return Err(HistoryError::Unavailable);
    }
    let existing: Option<String> = database
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(unavailable)?;
    if existing.is_some() {
        return Err(HistoryError::Unavailable);
    }
    database.execute_batch(SCHEMA).map_err(unavailable)
}

/// The history store of one Admin process.
pub struct Store {
    path: PathBuf,
    clock: Arc<Clock>,
    topics: Arc<Topics>,
    lock: Mutex<()>,
}

impl Store {
    /// The store at `path`.
    #[must_use]
    pub fn new(path: PathBuf, clock: Arc<Clock>, topics: Arc<Topics>) -> Self {
        Self {
            path,
            clock,
            topics,
            lock: Mutex::new(()),
        }
    }

    fn private_file(&self) -> Result<(), HistoryError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(unavailable)?;
        }
        let created = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits().cast_signed())
            .open(&self.path);
        match created {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = std::fs::symlink_metadata(&self.path).map_err(unavailable)?;
                if !metadata.file_type().is_file() {
                    return Err(HistoryError::Unavailable);
                }
                if metadata.permissions().mode() & 0o7777 != 0o600 {
                    std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                        .map_err(unavailable)?;
                }
                Ok(())
            }
            Err(error) => Err(unavailable(error)),
        }
    }

    /// Runs `work` in one transaction of the store, committed only when it succeeds.
    fn database<T>(
        &self,
        work: impl FnOnce(&Transaction<'_>) -> Result<T, HistoryError>,
    ) -> Result<T, HistoryError> {
        let _guard = lock(&self.lock);
        self.private_file()?;
        let mut database = Connection::open(&self.path).map_err(unavailable)?;
        database
            .busy_timeout(Duration::from_secs(5))
            .map_err(unavailable)?;
        initialize(&database)?;
        let transaction = database.transaction().map_err(unavailable)?;
        let result = work(&transaction)?;
        transaction.commit().map_err(unavailable)?;
        Ok(result)
    }

    /// Whether the store file does not exist yet.
    fn absent(&self) -> Result<bool, HistoryError> {
        match std::fs::symlink_metadata(&self.path) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn now(&self) -> String {
        crate::time::format::utc(self.clock.now_secs())
    }

    fn changed(&self, team_id: &str) {
        self.topics.team_changed(team_id, &["history"]);
    }

    fn append(&self, row: &Row<'_>) -> Result<bool, HistoryError> {
        let encoded = encoded(row.payload)?;
        let now = self.now();
        let committed = self.database(|database| {
            let mut provenance = if row.attached { "attached" } else { "plain" }.to_owned();
            if let Some(anchor) = row.anchor {
                let sql = "SELECT provenance FROM transcript WHERE team_id = ? AND event_key = ?";
                let Some(found) = text_row(database, sql, params![row.team_id, format!("{anchor}:user")])? else {
                    return Ok(false);
                };
                provenance = found;
            }
            let inserted = database
                .execute(
                    "INSERT OR IGNORE INTO transcript (team_id, event_key, payload, provenance, created_at) \
                     VALUES (?, ?, ?, ?, ?)",
                    params![row.team_id, row.event_key, encoded, provenance, now],
                )
                .map_err(unavailable)?;
            let mut committed = inserted == 1;
            if !committed {
                committed = payload_at(database, row.team_id, &row.event_key)?.as_deref() == Some(encoded.as_str());
            }
            if committed && let Some(finish) = row.finish {
                database
                    .execute(
                        "DELETE FROM resumable_turn WHERE team_id = ? AND turn_id = ?",
                        params![row.team_id, finish],
                    )
                    .map_err(unavailable)?;
            }
            Ok(committed)
        })?;
        if committed {
            self.changed(row.team_id);
        }
        Ok(committed)
    }

    /// Binds the Team's one resumable turn to `turn`, which must be an admitted user turn; whether it is now bound.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn bind_resumable_turn(&self, team: &str, turn: &str) -> Result<bool, HistoryError> {
        let team = team_id(team)?;
        let turn = turn_id(turn)?;
        self.database(|database| {
            let admitted: Option<i64> = database
                .query_row(
                    "SELECT 1 FROM transcript WHERE team_id = ? AND event_key = ?",
                    params![team, format!("{turn}:user")],
                    |row| row.get(0),
                )
                .optional()
                .map_err(unavailable)?;
            if admitted.is_none() {
                return Ok(false);
            }
            database
                .execute(
                    "INSERT OR IGNORE INTO resumable_turn (team_id, turn_id) VALUES (?, ?)",
                    params![team, turn],
                )
                .map_err(unavailable)?;
            let bound: Option<String> = database
                .query_row(
                    "SELECT turn_id FROM resumable_turn WHERE team_id = ?",
                    params![team],
                    |row| row.get(0),
                )
                .optional()
                .map_err(unavailable)?;
            Ok(bound.as_deref() == Some(turn.as_str()))
        })
    }

    /// The Team's resumable turn, if any.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn resumable_turn(&self, team: &str) -> Result<Option<String>, HistoryError> {
        let team = team_id(team)?;
        if self.absent()? {
            return Ok(None);
        }
        let found: Option<String> = self.database(|database| {
            database
                .query_row(
                    "SELECT turn_id FROM resumable_turn WHERE team_id = ?",
                    params![team],
                    |row| row.get(0),
                )
                .optional()
                .map_err(unavailable)
        })?;
        found
            .map(|turn| turn_id(&turn).map_err(|_| HistoryError::Unavailable))
            .transpose()
    }

    /// Ends one turn's resumable state.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn finish_resumable_turn(&self, turn: &str) -> Result<(), HistoryError> {
        let turn = turn_id(turn)?;
        if self.absent()? {
            return Ok(());
        }
        self.database(|database| {
            database
                .execute(
                    "DELETE FROM resumable_turn WHERE turn_id = ?",
                    params![turn],
                )
                .map(|_| ())
                .map_err(unavailable)
        })
    }

    /// Forgets one Team's transcript; the rows it removed.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn clear_team(&self, team: &str) -> Result<usize, HistoryError> {
        let team = team_id(team)?;
        if self.absent()? {
            return Ok(0);
        }
        let removed = self.database(|database| {
            let removed = database
                .execute("DELETE FROM transcript WHERE team_id = ?", params![team])
                .map_err(unavailable)?;
            database
                .execute(
                    "DELETE FROM resumable_turn WHERE team_id = ?",
                    params![team],
                )
                .map_err(unavailable)?;
            Ok(removed)
        })?;
        self.changed(&team);
        Ok(removed)
    }

    /// Forgets every transcript; the rows it removed.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError`].
    pub fn clear_all(&self) -> Result<usize, HistoryError> {
        if self.absent()? {
            return Ok(0);
        }
        self.database(|database| {
            let removed = database
                .execute("DELETE FROM transcript", [])
                .map_err(unavailable)?;
            database
                .execute("DELETE FROM resumable_turn", [])
                .map_err(unavailable)?;
            Ok(removed)
        })
    }
}

#[cfg(test)]
mod tests;
