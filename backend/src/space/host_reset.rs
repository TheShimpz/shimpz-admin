//! Password-plus-host-capability authority for destructive Local Space reset (`DELETE /api/space/host`).
//!
//! The release-bound CLI projects a one-use capability file; a reset presents the capability itself, whose digest the
//! file names. A Space with no Supervisor, or whose password record needs recovery, is reset by the capability alone;
//! an initialized Space also needs the Supervisor password.

use std::sync::LazyLock;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use team_protocol::python::regex::{Pattern, declared};

use super::reset::{self, Deletion};
use crate::{
    app::App,
    command::log,
    fault::{Fault, Outcome, Reply},
    fsio::{self, Requirements},
    json::{self, Value},
    record::{AuthState, StateError},
    signin::{audit::Outcome as Journal, local},
    supervisor::assertion::AuthorityKind,
    team::history,
};

/// The largest capability file.
pub const MAX_CAPABILITY_BYTES: u64 = 1024;
/// The longest a capability lives.
pub const MAX_CAPABILITY_SECONDS: i64 = 120;
const FIELDS: [&str; 6] = [
    "version",
    "purpose",
    "space_id",
    "created_at",
    "expires_at",
    "capability_sha256",
];
static SPACE_ID_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"space-[0-9a-f]{24}\Z"));
static CAPABILITY_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{64}\Z"));

/// The projected host reset capability is absent, unsafe, invalid, expired, or consumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityUnavailable;

fn timestamp(document: &Value, name: &str) -> Option<i64> {
    document.get(name).and_then(json::as_int)
}

/// Validates the private capability file against the presented capability: its digest and expiry evidence.
///
/// # Errors
///
/// Returns [`CapabilityUnavailable`].
pub fn verify_capability(
    app: &App,
    capability: &Value,
    now: i64,
) -> Result<(String, i64), CapabilityUnavailable> {
    let capability = json::as_str(capability)
        .filter(|value| CAPABILITY_RE.is_full(value))
        .ok_or(CapabilityUnavailable)?;
    if !SPACE_ID_RE.is_full(&app.config.space_id) {
        return Err(CapabilityUnavailable);
    }
    let requirements = Requirements {
        group: Some(fsio::egid()),
        single_link: true,
    };
    let raw = fsio::read_private(
        &app.config.reset_capability_path,
        MAX_CAPABILITY_BYTES,
        requirements,
    )
    .map_err(|_| CapabilityUnavailable)?;
    let document = json::parse(&raw).map_err(|_| CapabilityUnavailable)?;
    let (Some(created), Some(expires)) = (
        timestamp(&document, "created_at"),
        timestamp(&document, "expires_at"),
    ) else {
        return Err(CapabilityUnavailable);
    };
    let digest = json::get_str(&document, "capability_sha256").unwrap_or_default();
    let admitted = json::has_exactly(&document, &FIELDS)
        && document
            .get("version")
            .is_some_and(|version| json::equal(version, &json::int(1)))
        && json::get_str(&document, "purpose") == Some("space-reset")
        && json::get_str(&document, "space_id") == Some(app.config.space_id.as_str())
        && (now - MAX_CAPABILITY_SECONDS..=now).contains(&created)
        && (now..=now + MAX_CAPABILITY_SECONDS).contains(&expires)
        && (1..=MAX_CAPABILITY_SECONDS).contains(&(expires - created))
        && CAPABILITY_RE.is_full(digest);
    let presented = data_encoding::HEXLOWER
        .decode(capability.as_bytes())
        .map(|bytes| data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes)))
        .map_err(|_| CapabilityUnavailable)?;
    if !admitted || !bool::from(presented.as_bytes().ct_eq(digest.as_bytes())) {
        return Err(CapabilityUnavailable);
    }
    Ok((digest.to_owned(), expires))
}

fn no_store(status: u16, code: &str, detail: &str) -> Reply {
    Reply::new(status, json::detail_code(detail, code))
}

fn denied(app: &App) -> Outcome {
    app.audit
        .record("host-reset", Journal::Denied, None, None)
        .map_err(|_| Fault::Audit)?;
    Err(Fault::detail(
        403,
        "host reset authorization is unavailable",
    ))
}

/// Which deletion the presented authority admits, after the password when the Space needs one.
async fn authorized(app: &App, payload: &Value) -> Result<Result<Deletion, Reply>, Fault> {
    let only_capability = json::has_exactly(payload, &["capability"]);
    match app.store.authentication_state() {
        Err(StateError::PasswordRecord) => {
            if !only_capability {
                return Err(Fault::detail(400, "recovery reset accepts only capability"));
            }
            Ok(Ok(if app.store.local_supervisor().is_err() {
                Deletion::Bootstrap
            } else {
                Deletion::Established
            }))
        }
        Err(_) => Err(Fault::Internal),
        Ok(AuthState::Uninitialized) => {
            if !only_capability {
                return Err(Fault::detail(
                    400,
                    "uninitialized reset accepts only capability",
                ));
            }
            Ok(Ok(Deletion::Bootstrap))
        }
        Ok(_) => {
            if !json::has_exactly(payload, &["capability", "password"]) {
                return Ok(Err(no_store(
                    409,
                    "supervisor-password-required",
                    "Supervisor password is required",
                )));
            }
            let password = payload.get("password").cloned().unwrap_or(Value::Null);
            local::recheck_password(app, None, &password)
                .await
                .map_err(|fault| match fault {
                    Fault::Refused(refusal) if refusal.status == 403 => {
                        Fault::detail(401, "invalid Supervisor credentials")
                    }
                    other => other,
                })?;
            Ok(Ok(Deletion::Established))
        }
    }
}

/// Consumes exact host authority before invoking the matching Team deletion boundary.
///
/// # Errors
///
/// Returns 403 without the authority, 400 or 401 for the body or password, or the journal's refusal.
pub async fn reset(app: &App, payload: &Value) -> Outcome {
    let now = app.clock.now_secs();
    let Ok((digest, expires)) =
        verify_capability(app, payload.get("capability").unwrap_or(&Value::Null), now)
    else {
        log("info", "host_reset_denied_capability_unavailable");
        return denied(app);
    };
    let Ok(_setup) = app.domains.space.setup.try_lock() else {
        log("info", "host_reset_deferred_busy");
        return Ok(no_store(
            409,
            "host-reset-busy",
            "Supervisor setup or reset is in progress",
        ));
    };
    let deletion = match authorized(app, payload).await? {
        Ok(deletion) => deletion,
        Err(refusal) => return Ok(refusal),
    };
    if !app
        .store
        .consume_host_reset_capability(&digest, expires)
        .map_err(|_| Fault::Internal)?
    {
        log("info", "host_reset_denied_consumed_capability");
        return denied(app);
    }
    app.audit
        .record("host-reset", Journal::Ok, None, None)
        .map_err(|_| Fault::Audit)?;
    let team = match deletion {
        Deletion::Bootstrap => app.machine_team(),
        Deletion::Established => {
            app.scoped_team(&format!("host-reset-v1:{digest}"), AuthorityKind::HostReset)?
        }
    };
    let response = reset::space_reset(app, &team, deletion).await;
    log("info", "host_reset_completed");
    if response.status == 200 {
        history::end_runs(app, None);
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
