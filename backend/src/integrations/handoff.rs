//! One-use browser handoffs for Local OAuth completion.
//!
//! The Admin session cookie belongs to the hostname the Supervisor used (commonly `localhost`), while the reviewed
//! Local OAuth callbacks deliberately use `127.0.0.1`. This bounded process-local store lets an authenticated session
//! authorize the provider flow through Team, then publish one short-lived bearer handoff holding only the validated
//! redirect URL and a callback binding. The automatic start route consumes it exactly once; a custom HTTPS origin
//! instead keeps the handoff bound to its Admin session while the platform callback shows a one-use completion code.
//! No Admin session, OAuth token, authorization code, PKCE verifier, or provider client material is stored here.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use team_protocol::{
    identifiers::TEAM_ID_RE,
    python::regex::{Pattern, declared},
    websocket::CHALLENGE_ID_RE,
};

use super::cloudflare;
use crate::{clock::Clock, sync::lock};

/// How long a handoff lives.
pub const HANDOFF_TTL_MS: i64 = 600_000;
/// The most handoffs pending at once.
pub const HANDOFF_CAPACITY: usize = 256;
const CALLBACK_MODES: [&str; 3] = ["loopback", "local-domain", "out-of-band"];
const AUTOMATIC_CALLBACK_MODES: [&str; 2] = ["loopback", "local-domain"];
static HANDOFF_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{64}\Z"));
static COMPLETION_RE: LazyLock<Pattern> =
    LazyLock::new(|| declared(r"c1\.([A-Za-z0-9_-]{43})\.([0-9a-f]{64})\Z"));

/// The handoff is invalid, expired, reused, or unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HandoffError(pub &'static str);

/// What an authenticated preparation holds: the opaque handoff token and the browser binding.
#[derive(Clone, PartialEq, Eq)]
pub struct Preparation {
    /// The handoff token.
    pub token: String,
    /// The callback binding Team holds.
    pub session_binding: String,
}

/// The redirect recovered only by consuming an authorized handoff.
#[derive(Clone, PartialEq, Eq)]
pub struct Handoff {
    /// Where the browser goes.
    pub authorization_url: String,
    /// The binding its callback cookie carries.
    pub session_binding: String,
    /// The callback mode.
    pub callback_mode: String,
}

/// The exact values released to Team after an authenticated completion code.
#[derive(Clone, PartialEq, Eq)]
pub struct Completion {
    /// The OAuth state.
    pub state: String,
    /// The one-time claim.
    pub claim: String,
    /// The callback binding.
    pub session_binding: String,
}

#[derive(Clone)]
struct Pending {
    team_id: String,
    challenge_id: String,
    session_binding: String,
    callback_mode: String,
    authorization_url: Option<String>,
    state: Option<String>,
    session_digest: [u8; 32],
    expires_at_ms: i64,
}

fn session_digest(session: &str) -> Result<[u8; 32], HandoffError> {
    if !(32..=512).contains(&session.len())
        || !session.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(HandoffError("Admin session is unavailable"));
    }
    Ok(Sha256::digest(session.as_bytes()).into())
}

fn same_session(left: &[u8; 32], right: &[u8; 32]) -> bool {
    bool::from(left.ct_eq(right))
}

fn checked(value: &str, pattern: &Pattern, error: &'static str) -> Result<String, HandoffError> {
    if pattern.is_full(value) {
        Ok(value.to_owned())
    } else {
        Err(HandoffError(error))
    }
}

fn callback_mode(value: &str) -> Result<String, HandoffError> {
    if CALLBACK_MODES.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(HandoffError("OAuth callback mode is invalid"))
    }
}

/// The bounded in-memory handoffs; restart and expiry both fail closed.
pub struct Handoffs {
    clock: Arc<Clock>,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Handoffs {
    /// No handoff yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn expired(pending: &mut HashMap<String, Pending>, now: i64) {
        pending.retain(|_, handoff| handoff.expires_at_ms > now);
    }

    /// Reserves one handoff while an authenticated caller asks Team for authorization.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for invalid bindings, a full store, or one already pending for this session and
    /// challenge.
    pub fn issue(
        &self,
        team_id: &str,
        challenge_id: &str,
        session: &str,
        mode: &str,
    ) -> Result<Preparation, HandoffError> {
        let team_id = checked(team_id, &TEAM_ID_RE, "OAuth Team binding is invalid")?;
        let challenge_id = checked(challenge_id, CHALLENGE_ID_RE, "OAuth challenge is invalid")?;
        let digest = session_digest(session)?;
        let mode = callback_mode(mode)?;
        let now = self.clock.monotonic_ms();
        let mut pending = lock(&self.pending);
        Self::expired(&mut pending, now);
        if pending.len() >= HANDOFF_CAPACITY {
            return Err(HandoffError("OAuth handoff capacity reached"));
        }
        if pending.values().any(|handoff| {
            same_session(&handoff.session_digest, &digest)
                && handoff.team_id == team_id
                && handoff.challenge_id == challenge_id
        }) {
            return Err(HandoffError("OAuth authorization is already pending"));
        }
        let mut token = crate::random::hex(32);
        while pending.contains_key(&token) {
            token = crate::random::hex(32);
        }
        let binding = crate::random::urlsafe(32);
        pending.insert(
            token.clone(),
            Pending {
                team_id,
                challenge_id,
                session_binding: binding.clone(),
                callback_mode: mode,
                authorization_url: None,
                state: None,
                session_digest: digest,
                expires_at_ms: now + HANDOFF_TTL_MS,
            },
        );
        drop(pending);
        Ok(Preparation {
            token,
            session_binding: binding,
        })
    }

    /// Publishes one redirect only after Team returned a strictly validated URL.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for an unknown or already authorized handoff, or an invalid URL.
    pub fn authorize(&self, token: &str, authorization_url: &str) -> Result<(), HandoffError> {
        let token = checked(token, &HANDOFF_RE, "OAuth handoff is unavailable")?;
        let now = self.clock.monotonic_ms();
        let mut pending = lock(&self.pending);
        Self::expired(&mut pending, now);
        let handoff = pending
            .get_mut(&token)
            .filter(|handoff| handoff.authorization_url.is_none())
            .ok_or(HandoffError("OAuth handoff is unavailable"))?;
        let state = cloudflare::authorization_state(authorization_url, &handoff.callback_mode)
            .map_err(|_| HandoffError("OAuth authorization URL is invalid"))?;
        handoff.authorization_url = Some(authorization_url.to_owned());
        handoff.state = Some(state);
        Ok(())
    }

    /// Consumes one authorized handoff before exposing its redirect and binding.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for anything but an authorized handoff of this automatic mode.
    pub fn consume(&self, token: &str, mode: &str) -> Result<Handoff, HandoffError> {
        let unavailable = HandoffError("OAuth handoff is unavailable");
        let token = checked(token, &HANDOFF_RE, "OAuth handoff is unavailable")?;
        let mode = callback_mode(mode)?;
        if !AUTOMATIC_CALLBACK_MODES.contains(&mode.as_str()) {
            return Err(unavailable);
        }
        let now = self.clock.monotonic_ms();
        let handoff = {
            let mut pending = lock(&self.pending);
            Self::expired(&mut pending, now);
            pending.remove(&token)
        };
        match handoff {
            Some(Pending {
                authorization_url: Some(authorization_url),
                session_binding,
                callback_mode,
                ..
            }) if callback_mode == mode => Ok(Handoff {
                authorization_url,
                session_binding,
                callback_mode,
            }),
            _ => Err(unavailable),
        }
    }

    fn select(
        pending: &HashMap<String, Pending>,
        team_id: &str,
        challenge_id: &str,
        digest: &[u8; 32],
        out_of_band: bool,
    ) -> Option<String> {
        pending
            .iter()
            .find(|(_, handoff)| {
                handoff.team_id == team_id
                    && handoff.challenge_id == challenge_id
                    && (!out_of_band
                        || (handoff.callback_mode == "out-of-band"
                            && handoff.authorization_url.is_some()
                            && handoff.state.is_some()))
                    && same_session(&handoff.session_digest, digest)
            })
            .map(|(token, _)| token.clone())
    }

    /// Consumes one out-of-band handoff only for its exact Admin session and state.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for an invalid code or no matching handoff.
    pub fn complete(
        &self,
        team_id: &str,
        challenge_id: &str,
        session: &str,
        completion_code: &str,
    ) -> Result<Completion, HandoffError> {
        let team_id = checked(team_id, &TEAM_ID_RE, "OAuth Team binding is invalid")?;
        let challenge_id = checked(challenge_id, CHALLENGE_ID_RE, "OAuth challenge is invalid")?;
        let digest = session_digest(session)?;
        let invalid_code = HandoffError("OAuth completion code is invalid");
        if !COMPLETION_RE.is_full(completion_code) {
            return Err(invalid_code);
        }
        let found = COMPLETION_RE
            .search(completion_code)
            .ok()
            .flatten()
            .ok_or(invalid_code)?;
        let state = found
            .group(completion_code, 1)
            .ok_or(invalid_code)?
            .to_owned();
        let claim = found
            .group(completion_code, 2)
            .ok_or(invalid_code)?
            .to_owned();
        let now = self.clock.monotonic_ms();
        let mut pending = lock(&self.pending);
        Self::expired(&mut pending, now);
        let token = Self::select(&pending, &team_id, &challenge_id, &digest, true)
            .filter(|token| {
                pending[token]
                    .state
                    .as_ref()
                    .is_some_and(|stored| bool::from(stored.as_bytes().ct_eq(state.as_bytes())))
            })
            .ok_or(HandoffError("OAuth completion is unavailable"))?;
        let handoff = pending
            .remove(&token)
            .ok_or(HandoffError("OAuth completion is unavailable"))?;
        drop(pending);
        Ok(Completion {
            state,
            claim,
            session_binding: handoff.session_binding,
        })
    }

    /// Removes one exact pending handoff and returns only its private Team binding.
    ///
    /// # Errors
    ///
    /// Returns [`HandoffError`] for invalid bindings.
    pub fn cancel(
        &self,
        team_id: &str,
        challenge_id: &str,
        session: &str,
    ) -> Result<Option<String>, HandoffError> {
        let team_id = checked(team_id, &TEAM_ID_RE, "OAuth Team binding is invalid")?;
        let challenge_id = checked(challenge_id, CHALLENGE_ID_RE, "OAuth challenge is invalid")?;
        let digest = session_digest(session)?;
        let now = self.clock.monotonic_ms();
        let mut pending = lock(&self.pending);
        Self::expired(&mut pending, now);
        Ok(
            Self::select(&pending, &team_id, &challenge_id, &digest, false)
                .and_then(|token| pending.remove(&token))
                .map(|handoff| handoff.session_binding),
        )
    }

    /// Invalidates every handoff of one signed-out Admin session; how many it removed.
    pub fn cancel_session(&self, session: &str) -> usize {
        let Ok(digest) = session_digest(session) else {
            return 0;
        };
        let now = self.clock.monotonic_ms();
        let mut pending = lock(&self.pending);
        Self::expired(&mut pending, now);
        let before = pending.len();
        pending.retain(|_, handoff| !same_session(&handoff.session_digest, &digest));
        before - pending.len()
    }

    /// Removes an incomplete reservation after Team refused or the transport failed.
    pub fn discard(&self, token: &str) -> bool {
        HANDOFF_RE.is_full(token) && lock(&self.pending).remove(token).is_some()
    }
}

#[cfg(test)]
mod tests;
