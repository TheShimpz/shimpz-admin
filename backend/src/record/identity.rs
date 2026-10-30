//! The store's identities and authorities: the Supervisor's signing key and its rotation, the Routine identity, the
//! learned browser origin, and the consumed host reset capabilities.

use team_protocol::websocket::canonical_origin;

use super::{
    Journal, StateError, Store,
    classify::{AuthState, MAX_CONSUMED_HOST_RESETS, authentication_state, consumed_host_resets},
};
use crate::{
    json::{self, Value},
    supervisor::identity::LocalIdentity,
};

/// The new signing key a rotation saved beside the current one until Team answers (ADR-0051).
pub const PENDING_KEY_FIELD: &str = "supervisor_pending_signing_key";

/// A key rotation cannot begin, or is no longer open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RotationError;

fn validated_browser_origin(data: &Value) -> Result<Option<String>, StateError> {
    match data.get("browser_origin") {
        None => Ok(None),
        Some(origin) => match json::as_str(origin) {
            Some(text)
                if canonical_origin(Some(text)).as_deref() == Some(text)
                    && text.starts_with("https://") =>
            {
                Ok(Some(text.to_owned()))
            }
            _ => Err(StateError::Corrupt),
        },
    }
}

impl Store {
    /// The one password-authorized external HTTPS browser origin, when one is learned.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Corrupt`] for an invalid stored origin, or a store error.
    pub fn browser_origin(&self) -> Result<Option<String>, StateError> {
        validated_browser_origin(&self.get()?)
    }

    /// Persists one exact external HTTPS origin; returns `learned`, `replaced`, or `unchanged`. A change raises the
    /// `session` topic: what the session bootstrap answers changed with the admitted origins.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Corrupt`] for an origin that is not one exact HTTPS origin, or a store error.
    pub fn bind_browser_origin(&self, origin: &str) -> Result<&'static str, StateError> {
        if canonical_origin(Some(origin)).as_deref() != Some(origin)
            || !origin.starts_with("https://")
        {
            return Err(StateError::Corrupt);
        }
        let transition = self.mutate(
            |data| {
                let current = validated_browser_origin(data)?;
                if current.as_deref() == Some(origin) {
                    return Ok("unchanged");
                }
                json::set(data, "browser_origin", json::text(origin));
                Ok(if current.is_none() {
                    "learned"
                } else {
                    "replaced"
                })
            },
            |transition| *transition != "unchanged",
            None,
        )?;
        if transition != "unchanged" {
            self.topics.changed("session");
        }
        Ok(transition)
    }

    /// Durably consumes one purpose-bound host reset capability digest; `false` when it was consumed already or the
    /// memory of active ones is full.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Corrupt`] for invalid stored evidence, or a store error.
    pub fn consume_host_reset_capability(
        &self,
        digest: &str,
        expires_at: i64,
    ) -> Result<bool, StateError> {
        let now = self.now();
        self.mutate(
            |data| {
                let records = match data.get("consumed_host_resets") {
                    Some(records) => consumed_host_resets(records)?,
                    None => Vec::new(),
                };
                let active: Vec<(String, i64)> = records
                    .into_iter()
                    .filter(|(_, expires)| *expires >= now)
                    .collect();
                if active.iter().any(|(known, _)| known == digest)
                    || active.len() >= MAX_CONSUMED_HOST_RESETS
                {
                    return Ok(false);
                }
                let mut list: Vec<Value> = active
                    .iter()
                    .map(|(known, expires)| {
                        json::object(vec![
                            ("digest", json::text(known)),
                            ("expires_at", json::int(*expires)),
                        ])
                    })
                    .collect();
                list.push(json::object(vec![
                    ("digest", json::text(digest)),
                    ("expires_at", json::int(expires_at)),
                ]));
                json::set(data, "consumed_host_resets", Value::Array(list));
                Ok(true)
            },
            |consumed| *consumed,
            None,
        )
    }

    /// The validated private Local Supervisor identity.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Authority`] when it is unavailable.
    pub fn local_supervisor(&self) -> Result<LocalIdentity, StateError> {
        LocalIdentity::supervisor(&self.get()?).map_err(|_| StateError::Authority)
    }

    /// The pending signing key under the current Supervisor id, or `None` when no rotation is open.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Authority`] for an invalid pending key.
    pub fn pending_supervisor_key(&self) -> Result<Option<LocalIdentity>, StateError> {
        let data = self.get()?;
        if !json::contains(&data, PENDING_KEY_FIELD) {
            return Ok(None);
        }
        let current = LocalIdentity::supervisor(&data).map_err(|_| StateError::Authority)?;
        let pending = LocalIdentity::from_record(&data, "supervisor_id", PENDING_KEY_FIELD)
            .map_err(|_| StateError::Authority)?;
        if pending == current {
            return Err(StateError::Authority);
        }
        Ok(Some(pending))
    }

    /// Durably saves a new signing key beside the current one, journaling it first; one rotation at a time.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Rotation`] when a rotation cannot begin.
    pub fn begin_supervisor_key_rotation(
        &self,
        pending: &LocalIdentity,
        journal: Journal<'_, ()>,
    ) -> Result<(), StateError> {
        self.mutate(
            |data| {
                let current = LocalIdentity::supervisor(data).map_err(|_| StateError::Authority)?;
                if authentication_state(data)? != AuthState::Configured
                    || json::contains(data, PENDING_KEY_FIELD)
                    || pending.supervisor_id != current.supervisor_id
                    || *pending == current
                {
                    return Err(StateError::Rotation);
                }
                json::set(data, PENDING_KEY_FIELD, json::text(pending.key_hex()));
                Ok(())
            },
            |()| true,
            Some(journal),
        )
    }

    fn settle_rotation(
        &self,
        pending: &LocalIdentity,
        adopt: bool,
        journal: Journal<'_, ()>,
    ) -> Result<(), StateError> {
        self.mutate(
            |data| {
                if json::get_str(data, PENDING_KEY_FIELD) != Some(pending.key_hex().as_str()) {
                    return Err(StateError::Rotation);
                }
                if adopt {
                    json::set(
                        data,
                        "supervisor_signing_key",
                        json::text(pending.key_hex()),
                    );
                }
                json::remove(data, PENDING_KEY_FIELD);
                Ok(())
            },
            |()| true,
            Some(journal),
        )
    }

    /// Team pins the pending key now: make it current and drop the earlier one, journaling it first.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Rotation`] when the rotation is no longer open.
    pub fn adopt_supervisor_key(
        &self,
        pending: &LocalIdentity,
        journal: Journal<'_, ()>,
    ) -> Result<(), StateError> {
        self.settle_rotation(pending, true, journal)
    }

    /// Team kept the current key: drop the pending one, journaling it first.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Rotation`] when the rotation is no longer open.
    pub fn abandon_supervisor_key(
        &self,
        pending: &LocalIdentity,
        journal: Journal<'_, ()>,
    ) -> Result<(), StateError> {
        self.settle_rotation(pending, false, journal)
    }

    /// Admin's machine identity for Routine runs (ADR-0086), created with the Space's first need for it beside an
    /// established Supervisor identity.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Authority`] without a Supervisor identity.
    pub fn local_routine_identity(&self) -> Result<LocalIdentity, StateError> {
        self.mutate(
            |data| {
                LocalIdentity::supervisor(data).map_err(|_| StateError::Authority)?;
                let created = !json::contains(data, "routine_subject")
                    && !json::contains(data, "routine_signing_key");
                if created {
                    let identity = LocalIdentity::generate();
                    json::set(data, "routine_subject", json::text(&identity.supervisor_id));
                    json::set(data, "routine_signing_key", json::text(identity.key_hex()));
                }
                let identity =
                    LocalIdentity::from_record(data, "routine_subject", "routine_signing_key")
                        .map_err(|_| StateError::Authority)?;
                Ok((created, identity))
            },
            |(created, _)| *created,
            None,
        )
        .map(|(_, identity)| identity)
    }
}
