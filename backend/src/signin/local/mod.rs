//! The Local Supervisor's ceremonies (`local_auth`): sign-in, setup, recovery, passkeys, and the confirmed operations
//! a session socket begins and completes.
//!
//! The ceremonies share sign-in's process authorities ([`App::limiter`], [`App::tickets`], [`App::challenges`]): one
//! password derivation at a time with a lockout, one-use password tickets bound to their purpose, origin, and factor
//! generation, and one-use passkey challenges. Every outcome is journaled before the state it records is persisted.

pub mod ceremony;
pub mod operation;
pub mod passkey;

use std::sync::Arc;

use axum::{
    http::{HeaderMap, HeaderValue, header},
    response::Response,
};
use team_protocol::websocket::canonical_origin;

pub use operation::{
    Asker, Factor, OperationRefused, discard_operation, operation_factor, operation_refusal,
};

use super::{
    audit::Outcome as Journaled,
    passkeys::Ceremony as ChallengeCeremony,
    password::{self, MAX_PASSWORD_CHARS},
    tickets::{Issue, Purpose, TICKET_TTL_MS, Ticket},
    token,
    totp::Verification,
};
use crate::{
    fault::Fault,
    http::{browser, respond},
    json::{self, Value},
    process::app::App,
    record::{Ceremony, StateError},
};

/// The session cookie.
pub const SESSION_COOKIE: &str = "shimpz_admin";
/// The one-use password ticket cookie.
pub const TICKET_COOKIE: &str = "shimpz_admin_ticket";
/// The largest ceremony request body.
pub const MAX_BODY_BYTES: usize = 8 * 1024;
/// How recent a sign-in must be to register a passkey.
pub const PASSKEY_ENROLLMENT_FRESH_SECONDS: i64 = 5 * 60;
/// The detail of a ceremony whose factors changed.
pub const FACTORS_CHANGED: &str = "authentication factors changed; enter the password again";
/// The subject of the recovery-code replacement.
pub const RECOVERY_CODES_SUBJECT: &str = "recovery-codes";
/// The subject of the signing key rotation.
pub const SUPERVISOR_KEY_SUBJECT: &str = "supervisor-key";

/// A store failure as the route answers it.
#[must_use]
pub fn state_fault(error: &StateError) -> Fault {
    match error {
        StateError::PasswordRecord => Fault::PasswordRecord,
        StateError::Audit => Fault::Audit,
        StateError::Authority => Fault::Authority,
        StateError::Credential => Fault::CredentialRecord,
        _ => Fault::Internal,
    }
}

/// Journals one event, refusing the change when the journal is unavailable.
///
/// # Errors
///
/// Returns [`StateError::Audit`] when the journal refuses it.
pub fn journal(
    app: &App,
    event: &str,
    outcome: Journaled,
    origin: Option<&str>,
    method: Option<&str>,
) -> Result<(), StateError> {
    app.audit
        .record(event, outcome, origin, method)
        .map_err(|_| StateError::Audit)
}

/// Writes one structured log line of a fixed event name, never a value.
pub fn log(level: &str, event: &str) {
    crate::process::command::log(level, event);
}

/// Forgets every ticket and challenge after an authentication-state change.
pub fn factor_changed(app: &App) {
    app.tickets.clear();
    app.challenges.clear();
}

/// The exact `Origin` a ceremony request names: a static origin or any HTTPS one, or none.
///
/// # Errors
///
/// Returns 403 for a non-canonical or unadmitted `Origin`.
pub fn request_origin(app: &App, headers: &HeaderMap) -> Result<Option<String>, Fault> {
    let Some(raw) = browser::header(headers, "origin") else {
        return Ok(None);
    };
    if canonical_origin(Some(raw)).as_deref() != Some(raw) {
        return Err(Fault::detail(403, "request Origin is invalid"));
    }
    if app.config.static_origins.iter().any(|known| known == raw) || raw.starts_with("https://") {
        return Ok(Some(raw.to_owned()));
    }
    Err(Fault::detail(403, "request Origin is not admitted"))
}

/// Whether `origin` is HTTPS, the only origin a cookie is marked `Secure` for and Admin learns.
#[must_use]
pub fn external(origin: Option<&str>) -> Option<&str> {
    origin.filter(|origin| origin.starts_with("https://"))
}

/// A ceremony's JSON answer, never cached.
#[must_use]
pub fn answer(status: u16, body: &Value) -> Response {
    let mut response = respond::json_response(status, body);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Sets the ticket cookie on `response`.
pub fn set_ticket(response: &mut Response, token: &str, origin: Option<&str>) {
    let cookie = respond::cookie(
        TICKET_COOKIE,
        token,
        respond::CookieAttributes {
            max_age: TICKET_TTL_MS / 1000,
            path: "/api/",
            http_only: true,
            same_site: "strict",
            secure: external(origin).is_some(),
        },
    );
    respond::set_cookie(response, &cookie);
}

/// Issues a session of `method` under `secret`, sets its cookie, and deletes the ticket cookie.
pub fn set_session(
    app: &App,
    response: &mut Response,
    secret: &str,
    method: token::Method,
    origin: Option<&str>,
) {
    let value = token::issue(&app.sessions, secret, method, app.clock.now_secs());
    let cookie = respond::cookie(
        SESSION_COOKIE,
        &value,
        respond::CookieAttributes {
            max_age: token::TTL_SECONDS,
            path: "/",
            http_only: true,
            same_site: "strict",
            secure: external(origin).is_some(),
        },
    );
    respond::set_cookie(response, &cookie);
    respond::delete_cookie(response, TICKET_COOKIE, "/api/");
}

/// The store's session secret.
///
/// # Errors
///
/// Returns the store's fault.
pub fn session_secret(app: &App) -> Result<String, Fault> {
    app.store
        .session_secret()
        .map_err(|error| state_fault(&error))
}

fn too_many(retry_after: u64) -> Fault {
    Fault::Refused(
        crate::fault::Refusal::detail(429, "too many login attempts").retry_after(retry_after),
    )
}

/// Verifies `password` against `record` under `permit`, then records and journals the attempt's outcome.
fn settle(
    app: &App,
    password: &str,
    record: &Value,
    permit: password::Permit,
    origin: Option<&str>,
) -> Result<(), Fault> {
    let verified = password::verify_password(password, record);
    let lock_seconds = permit.finish(verified.as_ref().ok().map(|accepted| !accepted));
    let accepted = verified.map_err(|_| Fault::PasswordRecord)?;
    if lock_seconds > 0 {
        log("info", "login_locked");
        journal(app, "password-locked", Journaled::Denied, origin, None)
            .map_err(|error| state_fault(&error))?;
        return Err(too_many(lock_seconds));
    }
    if !accepted {
        log("info", "password_rejected");
        journal(app, "password-rejected", Journaled::Denied, origin, None)
            .map_err(|error| state_fault(&error))?;
        return Err(Fault::detail(401, "invalid Supervisor credentials"));
    }
    Ok(())
}

/// The Supervisor store record once the password passes sign-in's limiter and lockout; every refusal journaled.
///
/// # Errors
///
/// Returns 400 for a password outside its bounds, 429 while limited or locked, 401 for a wrong password, or the
/// store's and journal's faults.
pub async fn check_password(
    app: &Arc<App>,
    password: &Value,
    origin: Option<&str>,
) -> Result<Value, Fault> {
    let password = json::as_str(password)
        .filter(|password| {
            (1..=MAX_PASSWORD_CHARS).contains(&team_protocol::python::text::len(password))
        })
        .map(|password| zeroize::Zeroizing::new(password.to_owned()))
        .ok_or_else(|| Fault::detail(400, "invalid Supervisor credentials"))?;
    let record = app.store.get().map_err(|error| state_fault(&error))?;
    let permit = app
        .limiter
        .begin()
        .map_err(|limited| too_many(limited.retry_after))?;
    // The derivation, its permit, and the attempt's accounting and journal all live in the blocking task: a caller
    // that goes away (a closed socket) neither frees the permit early nor skips recording the attempt.
    let (task_app, checked) = (Arc::clone(app), record.clone());
    let origin = origin.map(str::to_owned);
    tokio::task::spawn_blocking(move || {
        settle(&task_app, &password, &checked, permit, origin.as_deref())
    })
    .await
    .unwrap_or(Err(Fault::PasswordRecord))?;
    Ok(record)
}

/// Confirms the Supervisor password for a session-held destructive operation within sign-in's own budget and lockout.
///
/// # Errors
///
/// Returns 403 for a wrong password, or sign-in's own refusal.
pub async fn recheck_password(
    app: &Arc<App>,
    origin: Option<&str>,
    password: &Value,
) -> Result<(), Fault> {
    match check_password(app, password, origin).await {
        Ok(_) => Ok(()),
        Err(Fault::Refused(refusal)) if refusal.status == 401 => {
            Err(Fault::detail(403, "Supervisor password is incorrect"))
        }
        Err(fault) => Err(fault),
    }
}

/// The ticket cookie's ticket for `purpose`, presented from the origin it was issued to under the current factors.
///
/// # Errors
///
/// Returns 401 for a missing or spent ticket, 403 for another origin, or 409 when the factors changed.
pub fn ticket(app: &App, headers: &HeaderMap, purpose: Purpose) -> Result<(String, Ticket), Fault> {
    let token = browser::cookie(headers, TICKET_COOKIE).unwrap_or_default();
    let ticket = app
        .tickets
        .consume(&token, purpose, "", None)
        .map_err(|_| {
            Fault::detail(
                401,
                "authentication ceremony expired; enter the password again",
            )
        })?;
    if request_origin(app, headers)? != ticket.origin {
        return Err(Fault::detail(403, "authentication ceremony origin changed"));
    }
    if app
        .store
        .factor_generation()
        .map_err(|error| state_fault(&error))?
        != ticket.generation
    {
        return Err(Fault::detail(409, FACTORS_CHANGED));
    }
    Ok((token, ticket))
}

/// Issues one ceremony ticket.
///
/// # Errors
///
/// Returns [`Fault::Internal`] at capacity.
pub fn issue_ticket(
    app: &App,
    purpose: Purpose,
    origin: Option<&str>,
    generation: i64,
) -> Result<String, Fault> {
    app.tickets
        .issue(Issue {
            purpose,
            origin,
            generation,
            subject: "",
            binding: None,
        })
        .map_err(|_| Fault::Internal)
}

/// Learns or replaces the external HTTPS origin a completed MFA ceremony came from, journaled first.
///
/// # Errors
///
/// Returns the store's or journal's fault.
pub fn bind_origin(app: &App, origin: Option<&str>) -> Result<(), Fault> {
    let Some(external) = external(origin) else {
        return Ok(());
    };
    let fault = |error: StateError| state_fault(&error);
    let current = app.store.browser_origin().map_err(fault)?;
    if current.as_deref() != Some(external) {
        let event = if current.is_none() {
            "origin-learned"
        } else {
            "origin-replaced"
        };
        journal(app, event, Journaled::Ok, Some(external), None).map_err(fault)?;
    }
    match app.store.bind_browser_origin(external).map_err(fault)? {
        "learned" => log("info", "browser_origin_learned"),
        "replaced" => log("info", "browser_origin_replaced"),
        _ => {}
    }
    Ok(())
}

/// One TOTP code of a ceremony, its outcome journaled (`accepted` names a success) before the attempt is persisted.
pub struct TotpAttempt<'a> {
    /// The ceremony.
    pub ceremony: Ceremony,
    /// The generation its ticket was issued under.
    pub generation: i64,
    /// The ticket's origin.
    pub origin: Option<&'a str>,
    /// The journal event of a success.
    pub accepted: &'a str,
    /// The fresh recovery set an enrollment activates.
    pub codes: Option<&'a Value>,
}

/// Why one TOTP code did not complete its ceremony.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TotpFailure {
    /// The code was refused, locked, or its ceremony expired or changed.
    Refused(Verification),
    /// The store, the journal, or the TOTP state failed.
    State(StateError),
}

impl TotpFailure {
    /// The closed HTTP status and detail a ceremony route answers.
    #[must_use]
    pub fn fault(&self) -> Fault {
        match self {
            Self::Refused(result) => {
                let (status, detail) = totp_refusal(*result);
                Fault::detail(status, detail)
            }
            Self::State(error) => state_fault(error),
        }
    }
}

/// Verifies one code as `attempt` says.
///
/// # Errors
///
/// Returns [`TotpFailure`].
pub fn complete_totp(
    app: &App,
    code: &Value,
    attempt: &TotpAttempt<'_>,
) -> Result<(), TotpFailure> {
    let journal_outcome = |result: &Verification| match result {
        Verification::Accepted => journal(
            app,
            attempt.accepted,
            Journaled::Ok,
            attempt.origin,
            Some("totp"),
        ),
        Verification::Locked => {
            journal(app, "totp-locked", Journaled::Denied, attempt.origin, None)
        }
        Verification::Invalid => journal(
            app,
            "totp-rejected",
            Journaled::Denied,
            attempt.origin,
            None,
        ),
        _ => Ok(()),
    };
    let result = app
        .store
        .verify_totp(
            code,
            attempt.ceremony,
            Some(attempt.generation),
            attempt.codes,
            &journal_outcome,
        )
        .map_err(TotpFailure::State)?;
    match result {
        Verification::Accepted => Ok(()),
        refused => Err(TotpFailure::Refused(refused)),
    }
}

/// The closed HTTP refusal of a TOTP outcome other than acceptance.
#[must_use]
pub const fn totp_refusal(result: Verification) -> (u16, &'static str) {
    match result {
        Verification::Locked => (429, "verification code is temporarily locked"),
        Verification::Expired => (409, "TOTP enrollment expired; enter the password again"),
        Verification::Changed => (409, FACTORS_CHANGED),
        _ => (401, "invalid verification code"),
    }
}

/// The Supervisor's 32-byte `WebAuthn` user handle, which an assertion may name.
///
/// # Errors
///
/// Returns the store's error, or [`StateError::Corrupt`] for a handle that is not hex.
pub fn user_handle(app: &App) -> Result<Vec<u8>, StateError> {
    let handle = app.store.webauthn_user_id()?;
    data_encoding::HEXLOWER
        .decode(handle.as_bytes())
        .map_err(|_| StateError::Corrupt)
}

/// Discards the passkey challenge of `token`: a ceremony completed with TOTP leaves none behind.
pub fn discard_challenge(app: &App, token: &str) {
    let _ = app
        .challenges
        .consume(token, ChallengeCeremony::Authentication);
}
