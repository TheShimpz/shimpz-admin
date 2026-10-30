//! The passkey steps the ceremonies share: availability at an origin, the sign-in options, and one verified
//! assertion committed against the ticket that offered it.

use super::{journal, log, state_fault};
use crate::{
    fault::Fault,
    json::Value,
    process::app::App,
    record::{PasskeyCommit, StateError},
    signin::{
        audit::Outcome as Journaled,
        passkeys::{self, Ceremony, PasskeyError},
        tickets::Ticket,
        webauthn,
    },
};

/// Why an assertion did not complete its ceremony.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssertionFailure {
    /// The factors or the credential changed during the ceremony (409).
    Conflict(&'static str),
    /// The assertion does not verify (401), journaled as rejected.
    Rejected,
    /// The store or journal failed.
    State(StateError),
}

impl AssertionFailure {
    /// The closed HTTP refusal a sign-in route answers.
    #[must_use]
    pub fn fault(&self) -> Fault {
        match self {
            Self::Conflict(detail) => Fault::detail(409, detail),
            Self::Rejected => Fault::detail(401, "invalid passkey authentication"),
            Self::State(error) => state_fault(error),
        }
    }
}

fn classified(error: StateError) -> AssertionFailure {
    match error {
        StateError::Passkey(PasskeyError::Conflict(detail)) => AssertionFailure::Conflict(detail),
        StateError::Passkey(PasskeyError::Unavailable(_)) => AssertionFailure::Rejected,
        other => AssertionFailure::State(other),
    }
}

fn verified(
    app: &App,
    token: &str,
    ticket: &Ticket,
    credential: &Value,
    accepted: &str,
) -> Result<PasskeyCommit, AssertionFailure> {
    let challenge = app
        .challenges
        .consume(token, Ceremony::Authentication)
        .map_err(|_| AssertionFailure::Rejected)?;
    if challenge.generation != ticket.generation
        || Some(challenge.origin.as_str()) != ticket.origin.as_deref()
    {
        return Err(AssertionFailure::Conflict(
            "authentication factors changed; retry",
        ));
    }
    let identifier = webauthn::credential_id(credential).map_err(|_| AssertionFailure::Rejected)?;
    let original = app
        .store
        .passkey_for_authentication(&identifier, &challenge.origin)
        .map_err(classified)?;
    let result = webauthn::verify_authentication(&challenge, credential, &original)
        .map_err(|error| classified(StateError::Passkey(error)))?;
    let origin = ticket.origin.as_deref();
    let journal_outcome = |commit: &PasskeyCommit| {
        if commit.1.is_some() {
            journal(app, "passkey-suspended", Journaled::Denied, origin, None)
        } else {
            journal(app, accepted, Journaled::Ok, origin, Some("passkey"))
        }
    };
    app.store
        .commit_passkey_authentication(
            &original,
            &result,
            ticket.generation,
            accepted == "login",
            &journal_outcome,
        )
        .map_err(classified)
}

/// Verifies one UV assertion against the ticket's own challenge and commits it: the session secret after it, and the
/// reason it suspended the passkey. A rejected assertion is journaled.
///
/// # Errors
///
/// Returns [`AssertionFailure`].
pub fn assertion(
    app: &App,
    token: &str,
    ticket: &Ticket,
    credential: &Value,
    accepted: &str,
) -> Result<PasskeyCommit, AssertionFailure> {
    match verified(app, token, ticket, credential, accepted) {
        Err(AssertionFailure::Rejected) => {
            journal(
                app,
                "passkey-rejected",
                Journaled::Denied,
                ticket.origin.as_deref(),
                None,
            )
            .map_err(AssertionFailure::State)?;
            Err(AssertionFailure::Rejected)
        }
        other => other,
    }
}

/// A suspended passkey ends every ceremony issued under the earlier factors.
pub fn suspended(app: &App, reason: &str) {
    super::factor_changed(app);
    if reason == "counter-regression" {
        log("warning", "passkey_suspended_counter_regression");
    } else {
        log("warning", "passkey_suspended_backup_identity_change");
    }
}

/// Whether the authenticated exact origin can host `WebAuthn`.
///
/// # Errors
///
/// Returns the store's fault when the learned origin cannot be read.
pub fn enrollment_available(app: &App, origin: Option<&str>) -> Result<bool, Fault> {
    let Some(origin) = origin else {
        return Ok(false);
    };
    if passkeys::rp_id_for_origin(origin).is_err() {
        return Ok(false);
    }
    if app
        .config
        .static_origins
        .iter()
        .any(|known| known == origin)
    {
        return Ok(true);
    }
    let learned = app
        .store
        .browser_origin()
        .map_err(|error| state_fault(&error))?;
    Ok(learned.as_deref() == Some(origin))
}

/// Whether this exact `WebAuthn` origin already has an active credential.
///
/// # Errors
///
/// Returns the store's fault.
pub fn registered(app: &App, origin: Option<&str>) -> Result<bool, Fault> {
    if !enrollment_available(app, origin)? {
        return Ok(false);
    }
    match app.store.active_passkeys(origin.unwrap_or_default()) {
        Ok(records) => Ok(!records.is_empty()),
        Err(StateError::Passkey(PasskeyError::Unavailable(_))) => Ok(false),
        Err(error) => Err(state_fault(&error)),
    }
}

/// The passkey options a sign-in offers at `origin`, when it has an active passkey.
///
/// # Errors
///
/// Returns the store's fault for anything but a passkey refusal.
pub fn login_options(
    app: &App,
    token: &str,
    origin: Option<&str>,
    generation: i64,
) -> Result<Option<Value>, Fault> {
    let Some(origin) = origin else {
        return Ok(None);
    };
    let records = match app.store.active_passkeys(origin) {
        Ok(records) if records.is_empty() => return Ok(None),
        Ok(records) => records,
        Err(StateError::Passkey(_)) => return Ok(None),
        Err(error) => return Err(state_fault(&error)),
    };
    let Ok(challenge) = app
        .challenges
        .issue(token, Ceremony::Authentication, origin, generation)
    else {
        return Ok(None);
    };
    Ok(passkeys::authentication_options(&challenge, &records).ok())
}
