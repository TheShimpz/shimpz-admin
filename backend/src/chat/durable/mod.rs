//! Durable chat turns on Admin's side (ADR-0125; plan B0 and B3): each Team turn Admin sends is recorded before it is
//! dispatched, with the exact body and the turn's grant, so an Admin restart neither loses the turn nor sends it as
//! another one, and the record goes only once Admin's history committed its ending and Team settled it.
//!
//! A grant is the authority the turn was admitted under, kept without any secret: the SHA-256 of its session token,
//! its Origin, the fingerprint of the session secret every token of that session is signed with, and the session's
//! absolute and idle deadlines at dispatch. Sessions themselves do not survive an Admin restart; a turn's grant does,
//! until its own deadlines. It ends for good when its session ends (logout, rotation, suspension, eviction, idle),
//! when the session secret changes (which every revocation of all sessions does, recorded before any listener runs),
//! or when its Origin is no longer admitted; a later login never revives it.

pub mod reattach;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use sha2::{Digest, Sha256};

use crate::{
    fsio::{self, PrivateReadError, Requirements},
    json::{self, Number, Value},
    process::app::App,
    signin::{
        sessions::{IDLE_MS, session_key},
        token,
    },
    supervisor::authority::Authority,
    sync::lock,
};

/// The record file's schema.
pub const SCHEMA: i64 = 1;
/// The most turns Admin keeps undelivered at once.
pub const MAX_TURNS: usize = 64;
/// How long Team holds a turn from its send without Admin (Team's `GRANT_SECONDS`): a turn whose session would end
/// sooner, by its absolute or its idle deadline, is not sent.
pub const GRANT_SECONDS: i64 = 3000;
/// The largest record file.
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// The authority a turn was admitted under, without any secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    /// The SHA-256 of the session's token: the authority Team binds the turn to.
    pub session: String,
    /// The Origin of the page that sent it.
    pub origin: String,
    /// The SHA-256 of the session secret its token is signed with.
    pub secret: String,
    /// When the session ends whatever its activity, in seconds.
    pub expires_at: i64,
    /// When the session ends without activity, as of the dispatch, in seconds.
    pub idle_until: i64,
}

/// One dispatched turn Admin has not settled yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    /// The Team.
    pub team_id: String,
    /// The history turn the person's message opened.
    pub history_id: Option<String>,
    /// The send's nonce.
    pub nonce: String,
    /// The exact Team chat body sent.
    pub body: Value,
    /// The authority it was sent under.
    pub grant: Grant,
    /// Whether its session ended: it is never sent again.
    pub revoked: bool,
}

/// Why the records could not be read or written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unavailable;

fn sha256_hex(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

/// The grant of `authority`, admitted now, or `None` when its session is no longer verifiable.
#[must_use]
pub fn grant_of(app: &App, authority: &Authority) -> Option<Grant> {
    let secret = app.store.session_secret().ok()?;
    let evidence = token::signed_evidence(&secret, authority.cookie())?;
    let now = app.clock.now_secs();
    let idle = app
        .sessions
        .idle_remaining_ms(authority.cookie())
        .unwrap_or(IDLE_MS);
    Some(Grant {
        session: authority.session.clone(),
        origin: authority.origin().to_owned(),
        secret: sha256_hex(secret.as_bytes()),
        expires_at: evidence.expires_at(),
        idle_until: now.saturating_add(idle / 1000),
    })
}

/// Whether `grant` still authorizes its turn: the same session secret, its deadlines not passed, and its Origin
/// still admitted.
#[must_use]
pub fn grant_current(app: &App, grant: &Grant) -> bool {
    let Ok(secret) = app.store.session_secret() else {
        return false;
    };
    let now = app.clock.now_secs();
    let admitted = app
        .allowed_origins()
        .is_ok_and(|origins| origins.contains(&grant.origin));
    admitted
        && sha256_hex(secret.as_bytes()) == grant.secret
        && now < grant.expires_at.min(grant.idle_until)
}

fn text_of(value: &Value, name: &str) -> Option<String> {
    json::get_str(value, name).map(str::to_owned)
}

fn int_of(value: &Value, name: &str) -> Option<i64> {
    match json::get(value, name) {
        Some(Value::Number(Number::Int(number))) => Some(*number),
        _ => None,
    }
}

fn grant_value(grant: &Grant) -> Value {
    json::object(vec![
        ("session", json::text(&grant.session)),
        ("origin", json::text(&grant.origin)),
        ("secret", json::text(&grant.secret)),
        ("expires_at", json::int(grant.expires_at)),
        ("idle_until", json::int(grant.idle_until)),
    ])
}

fn grant_from(value: &Value) -> Option<Grant> {
    Some(Grant {
        session: text_of(value, "session")?,
        origin: text_of(value, "origin")?,
        secret: text_of(value, "secret")?,
        expires_at: int_of(value, "expires_at")?,
        idle_until: int_of(value, "idle_until")?,
    })
}

fn pending_value(pending: &Pending) -> Value {
    json::object(vec![
        ("team_id", json::text(&pending.team_id)),
        (
            "history_id",
            pending.history_id.clone().map_or(Value::Null, json::text),
        ),
        ("nonce", json::text(&pending.nonce)),
        ("body", pending.body.clone()),
        ("grant", grant_value(&pending.grant)),
        ("revoked", Value::Bool(pending.revoked)),
    ])
}

fn pending_from(value: &Value) -> Option<Pending> {
    let history_id = match json::get(value, "history_id")? {
        Value::Null => None,
        Value::String(id) => Some(id.clone()),
        _ => return None,
    };
    let Some(Value::Bool(revoked)) = json::get(value, "revoked") else {
        return None;
    };
    Some(Pending {
        team_id: text_of(value, "team_id")?,
        history_id,
        nonce: text_of(value, "nonce")?,
        body: json::get(value, "body")?.clone(),
        grant: grant_from(json::get(value, "grant")?)?,
        revoked: *revoked,
    })
}

/// Admin's undelivered turns, in `turns.json` beside `admin.json`, and the ones this process's runs still own.
#[derive(Debug)]
pub struct Turns {
    path: PathBuf,
    lock: Mutex<()>,
    owned: Mutex<HashSet<(String, String)>>,
}

impl Turns {
    /// The records at `path`.
    #[must_use]
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            lock: Mutex::new(()),
            owned: Mutex::new(HashSet::new()),
        }
    }

    fn read(&self) -> Result<Vec<Pending>, Unavailable> {
        let requirements = Requirements {
            group: None,
            single_link: true,
        };
        let raw = match fsio::read_private(&self.path, MAX_BYTES, requirements) {
            Ok(raw) => raw,
            Err(PrivateReadError::NotFound) => return Ok(Vec::new()),
            Err(_) => return Err(Unavailable),
        };
        let value = json::parse(&raw).map_err(|_| Unavailable)?;
        if int_of(&value, "schema") != Some(SCHEMA) {
            return Err(Unavailable);
        }
        let Some(Value::Array(turns)) = json::get(&value, "turns") else {
            return Err(Unavailable);
        };
        turns
            .iter()
            .map(|value| pending_from(value).ok_or(Unavailable))
            .collect()
    }

    fn write(&self, turns: &[Pending]) -> Result<(), Unavailable> {
        let value = json::object(vec![
            ("schema", json::int(SCHEMA)),
            (
                "turns",
                Value::Array(turns.iter().map(pending_value).collect()),
            ),
        ]);
        fsio::replace_atomically(&self.path, json::compact(&value).as_bytes())
            .map_err(|_| Unavailable)
    }

    fn change<R>(&self, change: impl FnOnce(&mut Vec<Pending>) -> R) -> Result<R, Unavailable> {
        let _guard = lock(&self.lock);
        let mut turns = self.read()?;
        let result = change(&mut turns);
        self.write(&turns)?;
        Ok(result)
    }

    /// Records `pending` before it is dispatched, owned by this process's run until it is settled.
    ///
    /// # Errors
    /// [`Unavailable`] when it could not be made durable, or Admin holds as many undelivered turns as it may.
    pub fn record(&self, pending: Pending) -> Result<(), Unavailable> {
        let key = (pending.team_id.clone(), pending.nonce.clone());
        self.change(|turns| {
            if turns.iter().any(|turn| {
                (turn.team_id.as_str(), turn.nonce.as_str()) == (key.0.as_str(), key.1.as_str())
            }) {
                return Ok(());
            }
            if turns.len() >= MAX_TURNS {
                return Err(Unavailable);
            }
            turns.push(pending);
            Ok(())
        })??;
        lock(&self.owned).insert(key);
        Ok(())
    }

    /// Forgets the turn `nonce` of `team_id`: its ending is committed and Team settled it.
    ///
    /// # Errors
    /// [`Unavailable`] when the records could not be written.
    pub fn remove(&self, team_id: &str, nonce: &str) -> Result<(), Unavailable> {
        self.change(|turns| {
            turns.retain(|turn| (turn.team_id.as_str(), turn.nonce.as_str()) != (team_id, nonce));
        })?;
        self.release(team_id, nonce);
        Ok(())
    }

    /// Hands the turn back to the reattachment, which settles what its run could not.
    pub fn release(&self, team_id: &str, nonce: &str) {
        lock(&self.owned).remove(&(team_id.to_owned(), nonce.to_owned()));
    }

    /// Marks every turn of these ended sessions (every turn for `None`) revoked, before anything else learns of it.
    ///
    /// # Errors
    /// [`Unavailable`] when the records could not be written.
    pub fn revoke(&self, sessions: Option<&HashSet<String>>) -> Result<(), Unavailable> {
        self.change(|turns| {
            for turn in turns.iter_mut() {
                if sessions.is_none_or(|ended| ended.contains(&turn.grant.session)) {
                    turn.revoked = true;
                }
            }
        })
    }

    /// The undelivered turns no run of this process owns.
    ///
    /// # Errors
    /// [`Unavailable`] when the records cannot be read.
    pub fn unowned(&self) -> Result<Vec<Pending>, Unavailable> {
        let turns = {
            let _guard = lock(&self.lock);
            self.read()?
        };
        let owned = lock(&self.owned);
        Ok(turns
            .into_iter()
            .filter(|turn| !owned.contains(&(turn.team_id.clone(), turn.nonce.clone())))
            .collect())
    }

    /// Whether the turn is revoked, as recorded now.
    #[must_use]
    pub fn revoked(&self, team_id: &str, nonce: &str) -> bool {
        let _guard = lock(&self.lock);
        self.read().map_or(true, |turns| {
            turns
                .iter()
                .find(|turn| turn.team_id == team_id && turn.nonce == nonce)
                .is_none_or(|turn| turn.revoked)
        })
    }

    /// Forgets a deleted Team's turns, or every turn on a Space reset.
    ///
    /// # Errors
    /// [`Unavailable`] when the records could not be written.
    pub fn forget(&self, team_id: Option<&str>) -> Result<(), Unavailable> {
        self.change(|turns| {
            turns.retain(|turn| team_id.is_some_and(|team_id| turn.team_id != team_id));
        })
    }
}

/// Revokes, durably and before any other listener, the turns of every session that ends; a logout's token too, even
/// one this process no longer tracks.
pub fn listen(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    app.sessions.listen(Arc::new(move |ended| {
        if let Some(app) = weak.upgrade() {
            let _ = app.domains.chat.turns.revoke(ended);
        }
    }));
}

/// Revokes the turns sent under the session of `token`, whether or not this process still tracks it.
pub fn revoke_token(app: &App, token: &str) {
    let ended: HashSet<String> = std::iter::once(session_key(token)).collect();
    let _ = app.domains.chat.turns.revoke(Some(&ended));
}

#[cfg(test)]
mod tests;
