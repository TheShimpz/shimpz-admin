//! The sign-in ceremonies a browser completes over HTTP: setup and its TOTP enrollment, sign-in with TOTP, a passkey,
//! or a recovery code and its re-enrollment, and passkey registration.

use std::sync::Arc;

use axum::{http::HeaderMap, response::Response};

use super::{
    FACTORS_CHANGED, PASSKEY_ENROLLMENT_FRESH_SECONDS, TotpAttempt, TotpFailure, answer,
    bind_origin, check_password, complete_totp, discard_challenge, factor_changed, issue_ticket,
    journal, log, passkey, request_origin, session_secret, set_session, set_ticket, state_fault,
    ticket,
};
use crate::{
    fault::Fault,
    http::{body::exact_fields, browser},
    json::{self, Value},
    process::app::App,
    record::{AuthState, Ceremony, StateError},
    signin::{
        audit::Outcome as Journaled,
        passkeys::{self, Ceremony as ChallengeCeremony, PasskeyError},
        password, recovery,
        tickets::{Purpose, Ticket},
        token::{self, Method},
        totp::{Enrollment, Verification},
        webauthn,
    },
    supervisor::identity,
};

fn field<'a>(payload: &'a Value, name: &str) -> Result<&'a Value, Fault> {
    exact_fields(payload, &[name])?;
    Ok(json::get(payload, name).unwrap_or(&Value::Null))
}

fn enrollment_body(enrollment: &Enrollment) -> Value {
    json::object(vec![(
        "enrollment",
        json::object(vec![
            ("secret", json::text(&enrollment.secret)),
            ("uri", json::text(&enrollment.uri)),
        ]),
    )])
}

async fn first_setup(
    app: &Arc<App>,
    password: &Value,
    origin: Option<&str>,
) -> Result<Result<Enrollment, Response>, Fault> {
    let password = json::as_str(password)
        .map(|text| zeroize::Zeroizing::new(text.to_owned()))
        .ok_or_else(|| Fault::detail(400, "request body must contain only password"))?;
    if let Some(violation) = password::password_policy(&password) {
        let body = json::object(vec![
            ("code", json::text(violation.code())),
            ("detail", json::text(violation.detail())),
        ]);
        return Ok(Err(answer(400, &body)));
    }
    journal(app, "setup-started", Journaled::Ok, origin, None)
        .map_err(|error| state_fault(&error))?;
    let verifier = tokio::task::spawn_blocking(move || password::new_password_verifier(&password))
        .await
        .map_err(|_| Fault::Internal)?
        .map_err(|_| Fault::Internal)?;
    let enrollment = app
        .store
        .begin_supervisor_setup(&verifier)
        .map_err(|error| state_fault(&error))?;
    let current = app
        .store
        .local_supervisor()
        .map_err(|error| state_fault(&error))?;
    identity::materialize(&app.config.public_key_file, app.config.key_group, &current)
        .map_err(|_| Fault::Internal)?;
    Ok(Ok(enrollment))
}

/// Creates or resumes the password-bound mandatory TOTP enrollment.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub async fn setup(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let password = field(payload, "password")?;
    let origin = request_origin(app, headers)?;
    let current = app
        .store
        .authentication_state()
        .map_err(|error| state_fault(&error))?;
    if matches!(
        current,
        AuthState::Configured | AuthState::RecoveryEnrollment
    ) {
        return Err(Fault::detail(
            409,
            "Local Supervisor authentication is already configured",
        ));
    }
    let enrollment = if current == AuthState::Uninitialized {
        match first_setup(app, password, origin.as_deref()).await? {
            Ok(enrollment) => enrollment,
            Err(refused) => return Ok(refused),
        }
    } else {
        check_password(app, password, origin.as_deref()).await?;
        app.store
            .resume_totp_enrollment()
            .map_err(|error| state_fault(&error))?
    };
    let generation = app
        .store
        .factor_generation()
        .map_err(|error| state_fault(&error))?;
    let token = issue_ticket(app, Purpose::TotpEnrollment, origin.as_deref(), generation)?;
    let mut response = answer(202, &enrollment_body(&enrollment));
    set_ticket(&mut response, &token, origin.as_deref());
    Ok(response)
}

/// Activates the pending TOTP with a fresh recovery set, signs in, and shows the set's codes this one time.
async fn complete_enrollment(
    app: &Arc<App>,
    code: &Value,
    ticket: &Ticket,
    ceremony: Ceremony,
    accepted: &str,
) -> Result<Response, Fault> {
    let codes = tokio::task::spawn_blocking(recovery::new_set)
        .await
        .map_err(|_| Fault::Internal)?;
    let attempt = TotpAttempt {
        ceremony,
        generation: ticket.generation,
        origin: ticket.origin.as_deref(),
        accepted,
        codes: Some(&codes.record),
    };
    complete_totp(app, code, &attempt).map_err(|failure| failure.fault())?;
    bind_origin(app, ticket.origin.as_deref())?;
    factor_changed(app);
    let body = json::object(vec![
        ("ok", Value::Bool(true)),
        ("method", json::text("totp")),
        ("recovery_codes", json::strings(&codes.codes)),
    ]);
    let mut response = answer(200, &body);
    let secret = session_secret(app)?;
    set_session(
        app,
        &mut response,
        &secret,
        Method::Totp,
        ticket.origin.as_deref(),
    );
    Ok(response)
}

/// Activates TOTP and issues the first MFA session.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub async fn confirm_setup(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let code = field(payload, "code")?;
    let (_token, ticket) = ticket(app, headers, Purpose::TotpEnrollment)?;
    let response =
        complete_enrollment(app, code, &ticket, Ceremony::Setup, "setup-completed").await?;
    log("info", "enrollment_completed");
    Ok(response)
}

/// Verifies the password and issues only a short-lived second-factor ticket.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub async fn login(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let password = field(payload, "password")?;
    let current = app
        .store
        .authentication_state()
        .map_err(|error| state_fault(&error))?;
    if !matches!(
        current,
        AuthState::Configured | AuthState::RecoveryEnrollment
    ) {
        return Err(Fault::detail(
            409,
            "Local Supervisor MFA setup is incomplete",
        ));
    }
    let origin = request_origin(app, headers)?;
    check_password(app, password, origin.as_deref()).await?;
    let generation = app
        .store
        .factor_generation()
        .map_err(|error| state_fault(&error))?;
    let token = issue_ticket(app, Purpose::Login, origin.as_deref(), generation)?;
    // While a recovery code's re-enrollment is open, only another recovery code can begin it again.
    let mut methods = vec!["recovery-code"];
    let mut options = None;
    if current == AuthState::Configured {
        options = passkey::login_options(app, &token, origin.as_deref(), generation)?;
        methods = if options.is_some() {
            vec!["totp", "passkey", "recovery-code"]
        } else {
            vec!["totp", "recovery-code"]
        };
    }
    let mut body = json::object(vec![("methods", json::strings(methods))]);
    if let Some(options) = options {
        json::set(&mut body, "passkey_options", options);
    }
    let mut response = answer(202, &body);
    set_ticket(&mut response, &token, origin.as_deref());
    Ok(response)
}

/// Consumes one password ticket and completes sign-in with TOTP.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub fn confirm_login_totp(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let code = field(payload, "code")?;
    let (token, ticket) = ticket(app, headers, Purpose::Login)?;
    discard_challenge(app, &token);
    let attempt = TotpAttempt {
        ceremony: Ceremony::Login,
        generation: ticket.generation,
        origin: ticket.origin.as_deref(),
        accepted: "login",
        codes: None,
    };
    match complete_totp(app, code, &attempt) {
        Ok(()) => {}
        // TOTP is no longer what the ticket was issued for: a recovery code replaced it.
        Err(TotpFailure::State(StateError::Totp)) => {
            return Err(Fault::detail(409, FACTORS_CHANGED));
        }
        Err(failure) => return Err(failure.fault()),
    }
    bind_origin(app, ticket.origin.as_deref())?;
    let mut response = answer(
        200,
        &json::object(vec![
            ("ok", Value::Bool(true)),
            ("method", json::text("totp")),
        ]),
    );
    let secret = session_secret(app)?;
    set_session(
        app,
        &mut response,
        &secret,
        Method::Totp,
        ticket.origin.as_deref(),
    );
    log("info", "login_completed_totp");
    Ok(response)
}

/// Consumes one password ticket and completes sign-in with an exact-origin UV assertion.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub fn confirm_login_passkey(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let credential = field(payload, "credential")?;
    let (token, ticket) = ticket(app, headers, Purpose::Login)?;
    let (secret, suspension) = passkey::assertion(app, &token, &ticket, credential, "login")
        .map_err(|failure| failure.fault())?;
    if let Some(reason) = suspension {
        passkey::suspended(app, reason);
        return Err(Fault::detail(
            401,
            "passkey was suspended; enter the password and use TOTP",
        ));
    }
    bind_origin(app, ticket.origin.as_deref())?;
    let body = json::object(vec![
        ("ok", Value::Bool(true)),
        ("method", json::text("passkey")),
    ]);
    let mut response = answer(200, &body);
    set_session(
        app,
        &mut response,
        &secret,
        Method::Webauthn,
        ticket.origin.as_deref(),
    );
    log("info", "login_completed_passkey");
    Ok(response)
}

fn recovery_journal(
    app: &App,
    origin: Option<&str>,
    result: Verification,
) -> Result<(), StateError> {
    match result {
        Verification::Accepted => journal(
            app,
            "recovery-code-used",
            Journaled::Ok,
            origin,
            Some("recovery-code"),
        ),
        Verification::Locked => {
            journal(app, "recovery-code-locked", Journaled::Denied, origin, None)
        }
        _ => journal(
            app,
            "recovery-code-rejected",
            Journaled::Denied,
            origin,
            None,
        ),
    }
}

/// Spends one password ticket and one recovery code; admits only the re-enrollment of TOTP, never a session.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub async fn confirm_login_recovery(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let code = field(payload, "code")?.clone();
    let (token, ticket) = ticket(app, headers, Purpose::Login)?;
    discard_challenge(app, &token);
    let store = Arc::clone(&app.store);
    let derived = match tokio::task::spawn_blocking(move || store.recovery_candidate(&code)).await {
        Ok(Ok(derived)) => derived,
        Ok(Err(StateError::Totp)) => return Err(Fault::detail(409, FACTORS_CHANGED)),
        Ok(Err(error)) => return Err(state_fault(&error)),
        Err(_) => return Err(Fault::Internal),
    };
    let origin = ticket.origin.as_deref();
    let journal_outcome =
        |outcome: &(Verification, Option<Enrollment>)| recovery_journal(app, origin, outcome.0);
    let (result, enrollment) = app
        .store
        .spend_recovery_code(&derived, ticket.generation, &journal_outcome)
        .map_err(|error| state_fault(&error))?;
    let enrollment = match (result, enrollment) {
        (Verification::Locked, _) => {
            return Err(Fault::detail(
                429,
                "verification code is temporarily locked",
            ));
        }
        (Verification::Changed, _) => return Err(Fault::detail(409, FACTORS_CHANGED)),
        (_, None) => return Err(Fault::detail(401, "invalid recovery code")),
        (_, Some(enrollment)) => enrollment,
    };
    // Every session ended with the old factor; the re-enrollment is this browser's own, bound to the new generation.
    factor_changed(app);
    log("warning", "recovery_code_used");
    let generation = app
        .store
        .factor_generation()
        .map_err(|error| state_fault(&error))?;
    let reenrollment = issue_ticket(app, Purpose::RecoveryEnrollment, origin, generation)?;
    let mut response = answer(202, &enrollment_body(&enrollment));
    set_ticket(&mut response, &reenrollment, origin);
    Ok(response)
}

/// Completes the TOTP re-enrollment a recovery code began, issuing the session and a fresh set of codes.
///
/// # Errors
///
/// Returns the ceremony's refusal; a mistyped code is answered with a fresh ticket for the next one.
pub async fn confirm_recovery_enrollment(
    app: &Arc<App>,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let code = field(payload, "code")?;
    let (_token, ticket) = ticket(app, headers, Purpose::RecoveryEnrollment)?;
    match complete_enrollment(app, code, &ticket, Ceremony::Recovery, "recovery-completed").await {
        Ok(response) => {
            log("info", "recovery_enrollment_completed");
            Ok(response)
        }
        Err(Fault::Refused(refusal)) if refusal.status == 401 => {
            let origin = ticket.origin.as_deref();
            let mut refused = answer(401, &refusal.body);
            let token = issue_ticket(app, Purpose::RecoveryEnrollment, origin, ticket.generation)?;
            set_ticket(&mut refused, &token, origin);
            Ok(refused)
        }
        Err(other) => Err(other),
    }
}

fn passkey_conflict(error: StateError) -> Fault {
    match error {
        StateError::Passkey(error) => Fault::detail(409, error.message()),
        other => state_fault(&other),
    }
}

/// Starts registration from one admitted MFA-authenticated browser origin.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub fn begin_passkey_registration(
    app: &App,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    if json::members(payload).is_some_and(|members| !members.is_empty()) {
        return Err(Fault::detail(400, "request body must be an empty object"));
    }
    let (origin, session) = passkey_origin(app, headers)?;
    let secret = session_secret(app)?;
    let evidence = token::verify(&app.sessions, &app.clock, &secret, &session, false);
    // Freshness is the sign-in's own time, never an inference from when the session would expire.
    if evidence.is_none_or(|evidence| {
        app.clock.now_secs() - evidence.issued_at > PASSKEY_ENROLLMENT_FRESH_SECONDS
    }) {
        return Err(Fault::detail(
            401,
            "fresh multifactor authentication is required",
        ));
    }
    let generation = app
        .store
        .factor_generation()
        .map_err(|error| state_fault(&error))?;
    let records = app
        .store
        .passkeys_for_registration(&origin)
        .map_err(passkey_conflict)?;
    let challenge = app
        .challenges
        .issue(
            &session,
            ChallengeCeremony::Registration,
            &origin,
            generation,
        )
        .map_err(|error| Fault::detail(409, error.message()))?;
    let user_id = app.store.webauthn_user_id().map_err(passkey_conflict)?;
    let options = passkeys::registration_options(&challenge, &user_id, &records);
    Ok(answer(200, &json::object(vec![("options", options)])))
}

/// A registration's passkey refusal: a conflict, an unverifiable response, or invalid stored state.
fn registration_refusal(error: PasskeyError) -> Fault {
    match error {
        PasskeyError::Conflict(detail) => Fault::detail(409, detail),
        PasskeyError::Unavailable(detail) => Fault::detail(400, detail),
        PasskeyError::Invalid(_) => Fault::Internal,
    }
}

/// The admitted `WebAuthn` origin of a registration request and its session cookie.
fn passkey_origin(app: &App, headers: &HeaderMap) -> Result<(String, String), Fault> {
    let origin = request_origin(app, headers)?;
    if !passkey::enrollment_available(app, origin.as_deref())? {
        return Err(Fault::detail(
            409,
            "passkeys are unavailable at this Admin address",
        ));
    }
    let session = browser::cookie(headers, super::SESSION_COOKIE).unwrap_or_default();
    Ok((origin.unwrap_or_default(), session))
}

/// Persists one verified passkey and rotates every previous Local session.
///
/// # Errors
///
/// Returns the ceremony's refusal.
pub fn complete_passkey_registration(
    app: &App,
    headers: &HeaderMap,
    payload: &Value,
) -> Result<Response, Fault> {
    let credential = field(payload, "credential")?;
    let (origin, session) = passkey_origin(app, headers)?;
    let challenge = app
        .challenges
        .consume(&session, ChallengeCeremony::Registration)
        .map_err(registration_refusal)?;
    if challenge.origin != origin
        || challenge.generation
            != app
                .store
                .factor_generation()
                .map_err(|error| state_fault(&error))?
    {
        return Err(Fault::detail(409, "authentication factors changed; retry"));
    }
    let record = webauthn::verify_registration(&challenge, credential, app.clock.now_secs())
        .map_err(registration_refusal)?;
    let journal_outcome = |_secret: &String| {
        journal(
            app,
            "passkey-registered",
            Journaled::Ok,
            Some(&origin),
            None,
        )
    };
    let secret = app
        .store
        .add_passkey(&record, challenge.generation, &journal_outcome)
        .map_err(|error| match error {
            StateError::Passkey(error) => registration_refusal(error),
            other => state_fault(&other),
        })?;
    factor_changed(app);
    let mut response = answer(200, &json::object(vec![("registered", Value::Bool(true))]));
    set_session(app, &mut response, &secret, Method::Webauthn, Some(&origin));
    log("info", "passkey_registered");
    Ok(response)
}
