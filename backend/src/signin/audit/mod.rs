//! The durable, metadata-only journal of Local Supervisor authentication events (`audit.jsonl` beside `admin.json`).
//!
//! Each event is appended and synchronized before the change it describes, so a refused write refuses the change. A
//! failure is sticky for the life of the process: after a failed write or fsync the journal's durable content is
//! unknown, so every later authentication change is unavailable until Admin restarts. A line holds only the time, the
//! event, its outcome, the exact browser origin, and the second-factor method: never a password, code, credential,
//! ticket, session, capability, or digest.

use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rustix::fs::OFlags;
use team_protocol::websocket::canonical_origin;

use crate::{
    fsio,
    json::{self, Value},
    session::topics::Topics,
    sync::lock,
    time::format,
};

/// A journal file rotates at this size.
pub const MAX_BYTES: u64 = 1024 * 1024;
/// Full journals kept beside the current one.
pub const BACKUPS: usize = 2;

/// Every event the journal records.
pub const EVENTS: [&str; 24] = [
    "setup-started",
    "setup-completed",
    "password-rejected",
    "password-locked",
    "totp-rejected",
    "totp-locked",
    "passkey-rejected",
    "passkey-suspended",
    "passkey-registered",
    "login",
    "origin-learned",
    "origin-replaced",
    "operation-confirmed",
    "recovery-code-used",
    "recovery-code-rejected",
    "recovery-code-locked",
    "recovery-completed",
    "recovery-codes-generated",
    "supervisor-key-rotation-started",
    "supervisor-key-rotated",
    "supervisor-key-rotation-abandoned",
    "logout",
    "host-reset",
    "space-reset",
];
const SIGN_INS: [&str; 3] = ["login", "setup-completed", "recovery-completed"];
const SIGN_IN_FAILURES: [&str; 8] = [
    "password-rejected",
    "password-locked",
    "totp-rejected",
    "totp-locked",
    "passkey-rejected",
    "passkey-suspended",
    "recovery-code-rejected",
    "recovery-code-locked",
];

/// An event's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It happened.
    Ok,
    /// It was refused.
    Denied,
}

/// The journal cannot durably record an event, so the change it describes is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuditUnavailable;

/// The journal cannot be read back as the exact lines Admin wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryUnavailable;

/// The journal.
pub struct Audit {
    path: PathBuf,
    topics: Arc<Topics>,
    clock: Arc<crate::time::clock::Clock>,
    failed: Mutex<bool>,
}

fn safe(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_file()
        && metadata.nlink() == 1
        && metadata.uid() == fsio::euid()
        && metadata.mode() & 0o7777 == 0o600
}

fn rotated_name(journal: &Path, index: usize) -> PathBuf {
    let name = journal
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audit.jsonl");
    journal.with_file_name(format!("{name}.{index}"))
}

fn rotate(journal: &Path) -> Result<(), AuditUnavailable> {
    for index in (1..=BACKUPS).rev() {
        let source = if index > 1 {
            rotated_name(journal, index - 1)
        } else {
            journal.to_path_buf()
        };
        if let Ok(metadata) = std::fs::symlink_metadata(&source) {
            if !safe(&metadata) {
                return Err(AuditUnavailable);
            }
            std::fs::rename(&source, rotated_name(journal, index)).map_err(|_| AuditUnavailable)?;
        }
    }
    let parent = journal.parent().unwrap_or_else(|| Path::new("."));
    fsio::sync_directory(parent).map_err(|_| AuditUnavailable)
}

fn append(journal: &Path, line: &[u8]) -> Result<(), AuditUnavailable> {
    let parent = journal.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|_| AuditUnavailable)?;
    let existing = std::fs::symlink_metadata(journal).ok();
    if let Some(metadata) = &existing
        && metadata.len() + u64::try_from(line.len()).unwrap_or(u64::MAX) > MAX_BYTES
    {
        rotate(journal)?;
    }
    let created = std::fs::symlink_metadata(journal).is_err();
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags((OFlags::NOFOLLOW | OFlags::CLOEXEC).bits().cast_signed())
        .open(journal)
        .map_err(|_| AuditUnavailable)?;
    if !safe(&file.metadata().map_err(|_| AuditUnavailable)?) {
        return Err(AuditUnavailable);
    }
    file.write_all(line).map_err(|_| AuditUnavailable)?;
    file.sync_all().map_err(|_| AuditUnavailable)?;
    if created {
        fsio::sync_directory(parent).map_err(|_| AuditUnavailable)?;
    }
    Ok(())
}

/// The sign-in before the reader's own and the refused attempts between them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignInHistory {
    /// When and from which origin the previous sign-in completed.
    pub previous: Option<(String, Option<String>)>,
    /// The refused attempts since it.
    pub failures_since: usize,
}

impl Audit {
    /// The journal at `path`.
    #[must_use]
    pub fn new(path: PathBuf, topics: Arc<Topics>, clock: Arc<crate::time::clock::Clock>) -> Self {
        Self {
            path,
            topics,
            clock,
            failed: Mutex::new(false),
        }
    }

    /// Durably appends one event, or refuses so its caller refuses the change. Every journaled event can change the
    /// sign-in security summary, which `security/summary` then announces.
    ///
    /// # Errors
    ///
    /// Returns [`AuditUnavailable`] after any failed write, for the life of the process.
    ///
    /// # Panics
    ///
    /// Panics for an event, origin, or method outside the journal's closed vocabulary (a programming error).
    pub fn record(
        &self,
        event: &str,
        outcome: Outcome,
        origin: Option<&str>,
        method: Option<&str>,
    ) -> Result<(), AuditUnavailable> {
        assert!(
            EVENTS.contains(&event)
                && origin
                    .is_none_or(|origin| canonical_origin(Some(origin)).as_deref() == Some(origin))
                && method
                    .is_none_or(|method| ["totp", "passkey", "recovery-code"].contains(&method)),
            "invalid authentication audit event"
        );
        let mut entry = vec![
            ("ts", json::text(format::utc(self.clock.now_secs()))),
            ("event", json::text(event)),
            (
                "outcome",
                json::text(match outcome {
                    Outcome::Ok => "ok",
                    Outcome::Denied => "denied",
                }),
            ),
            ("origin", origin.map_or(Value::Null, json::text)),
        ];
        if let Some(method) = method {
            entry.push(("method", json::text(method)));
        }
        let mut line = json::dumps(&json::object(entry), json::SORTED_ASCII);
        line.push('\n');
        {
            let mut failed = lock(&self.failed);
            if *failed {
                return Err(AuditUnavailable);
            }
            if append(&self.path, line.as_bytes()).is_err() {
                *failed = true;
                return Err(AuditUnavailable);
            }
        }
        self.topics.changed("security/summary");
        Ok(())
    }

    fn read_lines(journal: &Path) -> Result<Vec<Vec<u8>>, HistoryUnavailable> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags((OFlags::NOFOLLOW | OFlags::CLOEXEC).bits().cast_signed())
            .open(journal)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(HistoryUnavailable),
        };
        let metadata = file.metadata().map_err(|_| HistoryUnavailable)?;
        if !safe(&metadata) || metadata.len() > 2 * MAX_BYTES {
            return Err(HistoryUnavailable);
        }
        let mut raw = Vec::new();
        file.take(2 * MAX_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| HistoryUnavailable)?;
        let mut lines: Vec<Vec<u8>> = raw
            .split(|byte| *byte == b'\n')
            .map(<[u8]>::to_vec)
            .collect();
        lines.pop();
        Ok(lines)
    }

    /// The sign-in before the one at `signed_in_at`, and the refused attempts to sign in between the two.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryUnavailable`] for an unsafe journal or an unreadable line.
    pub fn sign_in_history(&self, signed_in_at: i64) -> Result<SignInHistory, HistoryUnavailable> {
        let lines = {
            let _held = lock(&self.failed);
            let mut lines = Vec::new();
            for index in (1..=BACKUPS).rev() {
                lines.extend(Self::read_lines(&rotated_name(&self.path, index))?);
            }
            lines.extend(Self::read_lines(&self.path)?);
            lines
        };
        let entries: Vec<(i64, Value)> = lines
            .iter()
            .map(|line| entry(line))
            .collect::<Result<_, _>>()?;
        let sign_ins: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, (moment, value))| {
                json::get_str(value, "event").is_some_and(|event| SIGN_INS.contains(&event))
                    && json::get_str(value, "outcome") == Some("ok")
                    && *moment <= signed_in_at
            })
            .map(|(index, _)| index)
            .collect();
        let [.., previous, current] = sign_ins.as_slice() else {
            return Ok(SignInHistory {
                previous: None,
                failures_since: 0,
            });
        };
        let (moment, signed_in) = &entries[*previous];
        let failures_since = entries[previous + 1..*current]
            .iter()
            .filter(|(_, value)| {
                json::get_str(value, "event").is_some_and(|event| SIGN_IN_FAILURES.contains(&event))
            })
            .count();
        Ok(SignInHistory {
            previous: Some((
                format::utc(*moment),
                json::get_str(signed_in, "origin").map(str::to_owned),
            )),
            failures_since,
        })
    }
}

fn entry(line: &[u8]) -> Result<(i64, Value), HistoryUnavailable> {
    if !line.is_ascii() {
        return Err(HistoryUnavailable);
    }
    let value = json::parse(line).map_err(|_| HistoryUnavailable)?;
    let moment = json::get_str(&value, "ts")
        .and_then(format::parse_utc)
        .ok_or(HistoryUnavailable)?;
    let origin_ok = match value.get("origin") {
        None | Some(Value::Null) => true,
        Some(origin) => json::as_str(origin)
            .is_some_and(|origin| canonical_origin(Some(origin)).as_deref() == Some(origin)),
    };
    if json::get_str(&value, "event").is_none_or(|event| !EVENTS.contains(&event)) || !origin_ok {
        return Err(HistoryUnavailable);
    }
    Ok((moment, value))
}

#[cfg(test)]
mod tests;
