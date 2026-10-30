//! The Supervisor's confirmed operations (ADR-0051, ADR-0114 decision 6): the password, then exactly one second factor
//! that spends a ticket bound to the operation's subject, the asking socket and session, the Origin, and the factor
//! generation; the session and socket are checked again after the factor and immediately before the operation runs.

use std::sync::Arc;

use zeroize::Zeroizing;

use super::{
    TotpAttempt, TotpFailure, check_password, complete_totp, discard_challenge, factor_changed,
    journal, log,
    passkey::{self, AssertionFailure},
};
use crate::{
    app::App,
    fault::{Fault, Reply},
    http::body::exact_fields,
    json::{self, Value},
    record::{AuthState, Ceremony},
    signin::{
        audit::Outcome as Journaled,
        passkeys::{self, Ceremony as ChallengeCeremony},
        recovery,
        tickets::{Binding, Issue, Purpose, Ticket},
        token,
        totp::Verification,
    },
};

/// Who asks for a confirmed operation: the socket's bound Origin, its session cookie, and its ticket binding.
#[derive(Clone)]
pub struct Asker {
    /// The bound Origin.
    pub origin: Option<String>,
    /// The session cookie.
    pub session: Zeroizing<String>,
    /// The socket and session a ticket issued to the asker is bound to.
    pub binding: Binding,
}

/// The one second factor a confirmation is completed with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Factor {
    /// A TOTP code.
    Totp,
    /// A passkey assertion.
    Passkey,
}

/// One closed, secret-free reason a confirmation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OperationRefused {
    /// The status.
    pub status: u16,
    /// The closed code.
    pub code: &'static str,
    /// Seconds until a lockout ends, or zero.
    pub retry_after: u64,
}

const fn refused(status: u16, code: &'static str) -> OperationRefused {
    OperationRefused {
        status,
        code,
        retry_after: 0,
    }
}

/// The page's view of a refusal: its status, its code and, for a lockout, when to try again.
#[must_use]
pub fn operation_refusal(error: &OperationRefused) -> Reply {
    let mut body = json::object(vec![("code", json::text(error.code))]);
    if error.retry_after > 0 {
        json::set(
            &mut body,
            "retry_after",
            json::int(i64::try_from(error.retry_after).unwrap_or(i64::MAX)),
        );
    }
    Reply::new(error.status, body)
}

fn unavailable() -> OperationRefused {
    log("warning", "operation_confirmation_unavailable");
    refused(503, "authentication-unavailable")
}

/// An operation is confirmed only from a browser origin Admin already admits, never one it would learn.
fn operation_origin(app: &App, origin: Option<&str>) -> Result<String, OperationRefused> {
    let origin = origin.ok_or(refused(403, "authentication-origin-refused"))?;
    if app
        .config
        .static_origins
        .iter()
        .any(|known| known == origin)
    {
        return Ok(origin.to_owned());
    }
    let learned = app.store.browser_origin().map_err(|_| unavailable())?;
    if learned.as_deref() == Some(origin) {
        Ok(origin.to_owned())
    } else {
        Err(refused(403, "authentication-origin-refused"))
    }
}

/// The one password a confirmation starts with; any other body is the request's own 400.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn operation_password(payload: &Value) -> Result<&Value, Fault> {
    exact_fields(payload, &["password"])?;
    Ok(json::get(payload, "password").unwrap_or(&Value::Null))
}

/// Verifies the password one exact operation starts with, as sign-in does, within sign-in's limiter.
///
/// # Errors
///
/// Returns the refusal.
pub async fn verify_operation_password(
    app: &Arc<App>,
    asker: &Asker,
    password: &Value,
) -> Result<(), OperationRefused> {
    let origin = operation_origin(app, asker.origin.as_deref())?;
    match app.store.authentication_state() {
        Ok(AuthState::Configured) => {}
        Ok(_) => return Err(refused(409, "authentication-unavailable")),
        Err(_) => return Err(unavailable()),
    }
    match check_password(app, password, Some(&origin)).await {
        Ok(_) => Ok(()),
        Err(Fault::Refused(refusal)) if refusal.status == 429 => Err(OperationRefused {
            status: 429,
            code: "authentication-locked",
            retry_after: refusal.retry_after.unwrap_or(1),
        }),
        Err(Fault::Refused(_)) => Err(refused(401, "password-incorrect")),
        Err(_) => Err(unavailable()),
    }
}

fn operation_offer(
    app: &App,
    token: &str,
    origin: &str,
    generation: i64,
) -> Result<Value, OperationRefused> {
    if !passkey::registered(app, Some(origin)).map_err(|_| unavailable())? {
        return Ok(json::object(vec![("methods", json::strings(["totp"]))]));
    }
    let challenge = app
        .challenges
        .issue(token, ChallengeCeremony::Authentication, origin, generation)
        .map_err(|_| unavailable())?;
    let records = app
        .store
        .active_passkeys(origin)
        .map_err(|_| unavailable())?;
    let options =
        passkeys::authentication_options(&challenge, &records).map_err(|_| unavailable())?;
    Ok(json::object(vec![
        ("methods", json::strings(["totp", "passkey"])),
        ("passkey_options", options),
    ]))
}

/// After the password, offers the operation's second factor: the offer, and the ticket the asker's socket keeps.
///
/// # Errors
///
/// Returns the refusal.
pub fn offer_operation(
    app: &App,
    asker: &Asker,
    subject: &str,
) -> Result<(Value, String), OperationRefused> {
    let origin = operation_origin(app, asker.origin.as_deref())?;
    let generation = app.store.factor_generation().map_err(|_| unavailable())?;
    let token = app
        .tickets
        .issue(Issue {
            purpose: Purpose::Operation,
            origin: Some(&origin),
            generation,
            subject,
            binding: Some(asker.binding.clone()),
        })
        .map_err(|_| unavailable())?;
    match operation_offer(app, &token, &origin, generation) {
        Ok(offer) => Ok((offer, token)),
        Err(error) => {
            // The offer could not be made: its ticket and any challenge are spent before anyone could hold them.
            discard_operation(app, &token);
            Err(error)
        }
    }
}

/// Spends a pending operation ticket nobody will complete, and its passkey challenge with it.
pub fn discard_operation(app: &App, token: &str) {
    if token.is_empty() {
        return;
    }
    let _ = app.tickets.consume(token, Purpose::Operation, "", None);
    discard_challenge(app, token);
}

/// The one second factor a confirmation is completed with; any other body is the request's own 400.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn operation_factor(body: &Value) -> Result<(Factor, Value), Fault> {
    if json::has_exactly(body, &["code"])
        && let Some(code) = json::get(body, "code").filter(|code| json::as_str(code).is_some())
    {
        return Ok((Factor::Totp, code.clone()));
    }
    if json::has_exactly(body, &["credential"]) {
        let credential = json::get(body, "credential")
            .cloned()
            .unwrap_or(Value::Null);
        return Ok((Factor::Passkey, credential));
    }
    Err(Fault::detail(
        400,
        "request body must contain only code or credential",
    ))
}

/// The TOTP outcomes as an operation's refusals: a changed ticket is expired.
const fn totp_refusal(failure: &TotpFailure) -> OperationRefused {
    match failure {
        TotpFailure::Refused(Verification::Locked) => refused(429, "code-locked"),
        TotpFailure::Refused(Verification::Expired | Verification::Changed) => {
            refused(401, "authentication-expired")
        }
        TotpFailure::Refused(_) => refused(401, "code-incorrect"),
        TotpFailure::State(_) => refused(503, "authentication-unavailable"),
    }
}

const fn passkey_refusal(failure: &AssertionFailure) -> OperationRefused {
    match failure {
        AssertionFailure::Rejected => refused(401, "passkey-failed"),
        AssertionFailure::Conflict(_) => refused(401, "authentication-expired"),
        AssertionFailure::State(_) => refused(503, "authentication-unavailable"),
    }
}

fn second_factor(
    app: &App,
    confirmation: &Confirmation,
    ticket: &Ticket,
) -> Result<(), OperationRefused> {
    if confirmation.factor == Factor::Totp {
        discard_challenge(app, &confirmation.token);
        let attempt = TotpAttempt {
            ceremony: Ceremony::Operation,
            generation: ticket.generation,
            origin: ticket.origin.as_deref(),
            accepted: "operation-confirmed",
            codes: None,
        };
        return complete_totp(app, &confirmation.value, &attempt)
            .map_err(|failure| totp_refusal(&failure));
    }
    let (_secret, suspension) = passkey::assertion(
        app,
        &confirmation.token,
        ticket,
        &confirmation.value,
        "operation-confirmed",
    )
    .map_err(|failure| passkey_refusal(&failure))?;
    if let Some(reason) = suspension {
        passkey::suspended(app, reason);
        return Err(refused(401, "passkey-suspended"));
    }
    Ok(())
}

/// One completion of a confirmed operation: the ticket its asker's socket kept and the second factor offered.
pub struct Confirmation {
    /// The ticket.
    pub token: Zeroizing<String>,
    /// The factor.
    pub factor: Factor,
    /// The code or credential.
    pub value: Value,
}

async fn confirmed<C>(
    app: &App,
    asker: &Asker,
    subject: &str,
    confirmation: &Confirmation,
    current: C,
) -> Result<(), OperationRefused>
where
    C: Future<Output = bool>,
{
    operation_origin(app, asker.origin.as_deref())?;
    let expired = refused(401, "authentication-expired");
    let ticket = app
        .tickets
        .consume(
            &confirmation.token,
            Purpose::Operation,
            subject,
            Some(&asker.binding),
        )
        .map_err(|_| expired)?;
    let generation = app.store.factor_generation().map_err(|_| unavailable())?;
    if ticket.origin != asker.origin || generation != ticket.generation {
        return Err(expired);
    }
    second_factor(app, confirmation, &ticket)?;
    let secret = app.store.session_secret().map_err(|_| unavailable())?;
    let session = token::verify(&app.sessions, &app.clock, &secret, &asker.session, false);
    if session.is_none() || !current.await {
        return Err(expired);
    }
    Ok(())
}

/// Spends the operation's one ticket on exactly one second factor; once it returns `Ok` the caller dispatches the
/// operation at once. `current` rechecks the asking socket and its Origin after the factor.
///
/// # Errors
///
/// Returns the refusal; a refused completion spends the ticket's passkey challenge too.
pub async fn confirm_operation<C>(
    app: &App,
    asker: &Asker,
    subject: &str,
    confirmation: &Confirmation,
    current: C,
) -> Result<(), OperationRefused>
where
    C: Future<Output = bool>,
{
    let outcome = confirmed(app, asker, subject, confirmation, current).await;
    if outcome.is_err() {
        discard_challenge(app, &confirmation.token);
        return outcome;
    }
    log(
        "info",
        if confirmation.factor == Factor::Totp {
            "operation_confirmed_totp"
        } else {
            "operation_confirmed_passkey"
        },
    );
    Ok(())
}

/// Replaces every recovery code once the operation's second factor confirmed it, returning the new set once.
///
/// # Errors
///
/// Returns the store's or journal's fault.
pub async fn regenerate_recovery_codes(
    app: &Arc<App>,
    origin: Option<&str>,
) -> Result<Reply, Fault> {
    let codes = tokio::task::spawn_blocking(recovery::new_set)
        .await
        .map_err(|_| Fault::Internal)?;
    let journal_outcome =
        |(): &()| journal(app, "recovery-codes-generated", Journaled::Ok, origin, None);
    app.store
        .replace_recovery_codes(&codes.record, &journal_outcome)
        .map_err(|error| super::state_fault(&error))?;
    factor_changed(app);
    log("info", "recovery_codes_replaced");
    Ok(Reply::ok(json::object(vec![(
        "recovery_codes",
        json::strings(&codes.codes),
    )])))
}

/// Replaces the Supervisor's signing key once the operation's second factor confirmed it (ADR-0051); a rotation Team
/// has not answered yet stays open and is retried in the background.
pub async fn rotate_supervisor_key(app: &Arc<App>, asker: &Asker) -> Reply {
    use crate::space::supervisor_key::{self, Outcome, RotationFailure};
    match supervisor_key::rotate(app, &asker.session, asker.origin.as_deref()).await {
        Ok(Outcome::Rotated) => Reply::ok(json::object(vec![("rotated", Value::Bool(true))])),
        Ok(Outcome::Abandoned) => Reply::new(409, json::code("supervisor-key-rotation-refused")),
        Ok(Outcome::Pending) => {
            app.domains.signin.recovery.notify_one();
            Reply::new(503, json::code("supervisor-key-rotation-pending"))
        }
        Ok(Outcome::None) => Fault::Internal.reply(),
        Err(RotationFailure::Busy) => Reply::new(409, json::code("supervisor-key-rotation-busy")),
        Err(RotationFailure::Unavailable) => {
            log("warning", "supervisor_key_rotation_unavailable");
            Reply::new(503, json::code("supervisor-key-unavailable"))
        }
    }
}
