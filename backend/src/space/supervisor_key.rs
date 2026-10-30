//! Rotating the Supervisor's signing key under the key Team pins now (ADR-0051, ADR-0017).
//!
//! Team verifies every Supervisor assertion under its own pin of the Supervisor key and replaces that pin only on
//! `POST /v1/space/supervisor-key`, signed by the pinned key. Admin first saves the new key durably beside the current
//! one, then asks Team to switch. Team's answer decides: on the switch the new key becomes current, is published, and
//! the earlier one is dropped; on a definite refusal the pending key is dropped and the current one stays. When Team
//! cannot be reached the pending key is kept, and Admin retries the same rotation (after a restart too), first signed
//! by the earlier key and, when Team refuses that one because it already switched, signed by the new one.

use std::{
    sync::{Arc, Weak},
    time::Duration,
};

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use sha2::{Digest, Sha256};

use crate::{
    fault::Reply,
    json::{self, Value},
    process::app::App,
    record::StateError,
    signin::{audit::Outcome as Journaled, local::journal},
    supervisor::{
        assertion::AuthorityKind,
        identity::{self, LocalIdentity},
    },
    team::transport::{Scope, Team},
};

/// Team's rotation endpoint.
pub const ROTATION_PATH: &str = "/v1/space/supervisor-key";
/// How often an open rotation is retried.
pub const RETRY: Duration = Duration::from_secs(30);

/// How a rotation settled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No rotation was open.
    None,
    /// Team pins the new key.
    Rotated,
    /// Team kept the current key.
    Abandoned,
    /// Team's answer decides nothing yet.
    Pending,
}

/// Why a rotation could not run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RotationFailure {
    /// A rotation cannot begin now.
    Busy,
    /// The store, the journal, or the authority is unavailable.
    Unavailable,
}

impl From<StateError> for RotationFailure {
    fn from(error: StateError) -> Self {
        if error == StateError::Rotation {
            Self::Busy
        } else {
            Self::Unavailable
        }
    }
}

async fn ask_team(
    app: &App,
    signer: &LocalIdentity,
    authority: &str,
    pending: &LocalIdentity,
) -> Result<Reply, RotationFailure> {
    let scope = Scope::new(authority, signer.clone(), AuthorityKind::Session)
        .map_err(|_| RotationFailure::Unavailable)?;
    let team = Team::scoped(Arc::clone(&app.team_client), scope);
    let body = json::object(vec![(
        "public_key",
        json::text(BASE64URL_NOPAD.encode(&pending.public_key_raw())),
    )]);
    team.call("POST", ROTATION_PATH, Some(&body))
        .await
        .map_err(|_| RotationFailure::Unavailable)
}

/// `Some(true)` when Team pins the pending key; `Some(false)` on a definite refusal; `None` when it decides nothing.
fn switched(response: &Reply, pending: &LocalIdentity) -> Option<bool> {
    if response.status == 200 {
        let expected = json::object(vec![
            ("rotated", Value::Bool(true)),
            (
                "key_sha256",
                json::text(HEXLOWER.encode(&Sha256::digest(pending.public_key_raw()))),
            ),
        ]);
        if json::equal(&json::without(&response.body, "trace_id"), &expected) {
            return Some(true);
        }
        // Team switched to some key, but not this one: keep both keys rather than guess which one Team pins.
        crate::process::command::log("error", "supervisor_key_rotation_other_key");
        return None;
    }
    if response.status >= 500 {
        return None;
    }
    Some(false)
}

fn adopt(app: &App, pending: &LocalIdentity) -> Result<Outcome, RotationFailure> {
    let journal_outcome =
        |(): &()| journal(app, "supervisor-key-rotated", Journaled::Ok, None, None);
    app.store.adopt_supervisor_key(pending, &journal_outcome)?;
    crate::process::command::log("warning", "supervisor_key_rotated");
    if identity::materialize(&app.config.public_key_file, app.config.key_group, pending).is_err() {
        // Team verifies under its own pin; the published copy is written again on the next start.
        crate::process::command::log("warning", "supervisor_public_key_unpublished");
    }
    Ok(Outcome::Rotated)
}

fn abandon(app: &App, pending: &LocalIdentity) -> Result<Outcome, RotationFailure> {
    let journal_outcome = |(): &()| {
        journal(
            app,
            "supervisor-key-rotation-abandoned",
            Journaled::Denied,
            None,
            None,
        )
    };
    app.store
        .abandon_supervisor_key(pending, &journal_outcome)?;
    crate::process::command::log("warning", "supervisor_key_rotation_abandoned");
    Ok(Outcome::Abandoned)
}

/// Settles the open rotation, if any, with Team's answer; [`Outcome::Pending`] while Team's answer decides nothing.
///
/// `authority` is the Supervisor session that asked for the rotation; a retry without one signs under a fresh
/// one-time value, which Team records only as a digest.
///
/// # Errors
///
/// Returns [`RotationFailure`].
pub async fn resolve(app: &App, authority: Option<&str>) -> Result<Outcome, RotationFailure> {
    let _held = app.domains.signin.rotation.lock().await;
    let Some(pending) = app.store.pending_supervisor_key()? else {
        return Ok(Outcome::None);
    };
    let current = app.store.local_supervisor()?;
    let session = authority.map_or_else(|| crate::random::urlsafe(32), str::to_owned);
    let first = ask_team(app, &current, &session, &pending).await?;
    let mut decided = switched(&first, &pending);
    if decided == Some(false) && matches!(first.status, 403 | 409) {
        // Team refuses the earlier key once it pins the new one: the new key's own request shows it.
        decided = switched(
            &ask_team(app, &pending, &session, &pending).await?,
            &pending,
        );
    }
    match decided {
        None => {
            crate::process::command::log("warning", "supervisor_key_rotation_waiting");
            Ok(Outcome::Pending)
        }
        Some(true) => adopt(app, &pending),
        Some(false) => abandon(app, &pending),
    }
}

/// Saves a new key, journaled first, and asks Team to pin it; an open rotation is settled before a new one begins.
///
/// # Errors
///
/// Returns [`RotationFailure`].
pub async fn rotate(
    app: &App,
    authority: &str,
    origin: Option<&str>,
) -> Result<Outcome, RotationFailure> {
    let outcome = resolve(app, Some(authority)).await?;
    if matches!(outcome, Outcome::Rotated | Outcome::Pending) {
        return Ok(outcome);
    }
    let current = app.store.local_supervisor()?;
    let pending = LocalIdentity::with_new_key(&current.supervisor_id);
    let journal_outcome = |(): &()| {
        journal(
            app,
            "supervisor-key-rotation-started",
            Journaled::Ok,
            origin,
            None,
        )
    };
    app.store
        .begin_supervisor_key_rotation(&pending, &journal_outcome)?;
    resolve(app, Some(authority)).await
}

/// Publishes the current key of an initialized Supervisor, as every start does.
fn publish(app: &App) {
    match app.store.is_initialized() {
        Ok(true) => {
            let published = app.store.local_supervisor().is_ok_and(|current| {
                identity::materialize(&app.config.public_key_file, app.config.key_group, &current)
                    .is_ok()
            });
            if !published {
                crate::process::command::log("error", "supervisor_public_key_unpublished");
            }
        }
        Ok(false) => {}
        Err(_) => crate::process::command::log("error", "password_record_requires_recovery"),
    }
}

/// Publishes the current key, then retries an open rotation in the background: at start, when woken, and every
/// [`RETRY`] while the process lives.
pub fn start_recovery(app: &Arc<App>) {
    publish(app);
    let weak = Arc::downgrade(app);
    tokio::spawn(retry(weak));
}

async fn retry(app: Weak<App>) {
    let Some(wake) = app
        .upgrade()
        .map(|current| Arc::clone(&current.domains.signin.recovery))
    else {
        return;
    };
    let mut first = true;
    loop {
        if !first {
            let _ = tokio::time::timeout(RETRY, wake.notified()).await;
        }
        first = false;
        let Some(current) = app.upgrade() else {
            return;
        };
        if resolve(&current, None).await.is_err() {
            // An unreadable store or a refused journal keeps both keys; the next attempt tries again.
            crate::process::command::log("error", "supervisor_key_rotation_retry_failed");
        }
    }
}

#[cfg(test)]
mod tests;
