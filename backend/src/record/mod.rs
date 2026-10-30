//! The Admin's private store, `admin.json` (0600) on its dedicated data volume.
//!
//! It holds the password record, the session-signing secret, the Supervisor and Routine signing keys, the second
//! factors, and the local model and decision keys. Model keys stay here: they are never seeded into a Brain or Team
//! environment nor returned to the browser. A damaged store fails loud: it never reads as "no password set", which would
//! reopen the first-run bootstrap.

pub mod classify;
mod factors;
mod identity;
mod keys;

use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

pub use classify::{AuthState, validated_passkey};
pub use factors::{Ceremony, PasskeyCommit};
pub use identity::RotationError;

use crate::{
    clock::Clock,
    fsio,
    json::{self, Value},
    session::topics::Topics,
    signin::sessions::Sessions,
    sync::lock,
};

/// Every reason a store operation fails.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateError {
    /// The file is corrupt, changed while read, or holds a value outside its contract.
    Corrupt,
    /// The file could not be read or written.
    Io,
    /// The password record needs bounded recovery.
    PasswordRecord,
    /// The TOTP factor or its ceremony is unavailable.
    Totp,
    /// A passkey is invalid, unavailable, or changed.
    Passkey(crate::signin::passkeys::PasskeyError),
    /// The Supervisor identity is unavailable.
    Authority,
    /// A key rotation cannot begin or is no longer open.
    Rotation,
    /// The password is already configured.
    AlreadyConfigured,
    /// A stored model or decision key record is invalid.
    Credential,
    /// The authentication journal refused the change.
    Audit,
}

/// What a journal callback raises to refuse the transaction it records.
pub type Journal<'a, R> = &'a dyn Fn(&R) -> Result<(), StateError>;

/// A file's identity: device, inode, modification time (seconds and nanoseconds), and size.
type FileIdentity = (u64, u64, i64, i64, u64);

struct Cache {
    identity: Option<FileIdentity>,
    text: String,
}

/// The store.
pub struct Store {
    path: PathBuf,
    clock: Arc<Clock>,
    sessions: Arc<Sessions>,
    topics: Arc<Topics>,
    inner: Mutex<Option<Cache>>,
}

fn identity_of(path: &Path) -> Result<Option<FileIdentity>, StateError> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(Some((
            metadata.dev(),
            metadata.ino(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.size(),
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StateError::Io),
    }
}

impl Store {
    /// The store at `path`.
    #[must_use]
    pub fn new(
        path: PathBuf,
        clock: Arc<Clock>,
        sessions: Arc<Sessions>,
        topics: Arc<Topics>,
    ) -> Self {
        Self {
            path,
            clock,
            sessions,
            topics,
            inner: Mutex::new(None),
        }
    }

    /// The store's path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_locked(&self, cache: &mut MutexGuard<'_, Option<Cache>>) -> Result<Value, StateError> {
        let identity = identity_of(&self.path)?;
        if let Some(cached) = cache.as_ref()
            && cached.identity == identity
        {
            return json::parse(cached.text.as_bytes()).map_err(|_| StateError::Corrupt);
        }
        let (text, value) = if identity.is_none() {
            ("{}".to_owned(), json::empty())
        } else {
            let raw = std::fs::read(&self.path).map_err(|_| StateError::Io)?;
            let text = String::from_utf8(raw).map_err(|_| StateError::Corrupt)?;
            let value = json::parse(text.as_bytes()).map_err(|_| StateError::Corrupt)?;
            if identity_of(&self.path)? != identity || json::members(&value).is_none() {
                return Err(StateError::Corrupt);
            }
            (text, value)
        };
        **cache = Some(Cache { identity, text });
        Ok(value)
    }

    /// The whole store; a missing file is `{}` (a fresh install).
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Corrupt`] or [`StateError::Io`].
    pub fn get(&self) -> Result<Value, StateError> {
        let mut cache = lock(&self.inner);
        self.read_locked(&mut cache)
    }

    fn write_locked(
        &self,
        cache: &mut MutexGuard<'_, Option<Cache>>,
        data: &Value,
    ) -> Result<(), StateError> {
        let text = json::indented(data);
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| StateError::Io)?;
        }
        fsio::replace_atomically(&self.path, text.as_bytes()).map_err(|_| StateError::Io)?;
        **cache = Some(Cache {
            identity: identity_of(&self.path)?,
            text,
        });
        Ok(())
    }

    /// One read-modify-write transaction under the store's lock: `update` changes the record, `should_write` decides
    /// from its result whether to persist it, and `journal` records the outcome first, refusing the write when it
    /// fails. A rotated session secret ends every session at once.
    ///
    /// # Errors
    ///
    /// Returns the error of `update`, `journal`, or the store.
    pub fn mutate<R>(
        &self,
        update: impl FnOnce(&mut Value) -> Result<R, StateError>,
        should_write: impl FnOnce(&R) -> bool,
        journal: Option<Journal<'_, R>>,
    ) -> Result<R, StateError> {
        let rotated = {
            let mut cache = lock(&self.inner);
            let mut data = self.read_locked(&mut cache)?;
            let secret = json::get(&data, "session_secret").cloned();
            let result = update(&mut data)?;
            if !should_write(&result) {
                return Ok(result);
            }
            if let Some(journal) = journal {
                journal(&result)?;
            }
            self.write_locked(&mut cache, &data)?;
            (
                json::get(&data, "session_secret").cloned() != secret,
                result,
            )
        };
        let (rotated, result) = rotated;
        if rotated {
            self.sessions.end_all();
        }
        Ok(result)
    }

    fn mutate_always<R>(
        &self,
        update: impl FnOnce(&mut Value) -> Result<R, StateError>,
    ) -> Result<R, StateError> {
        self.mutate(update, |_| true, None)
    }

    fn now(&self) -> i64 {
        self.clock.now_secs()
    }
}

#[cfg(test)]
mod tests;
