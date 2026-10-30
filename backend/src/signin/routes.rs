//! The sign-in ceremonies' HTTP routes and the session bootstrap.

use std::{future::Future, sync::Arc};

use axum::{
    extract::{Request, State},
    http::HeaderMap,
    response::Response,
};
use team_protocol::websocket::canonical_origin;

use super::{
    audit::Outcome as Journaled,
    local::{self, MAX_BODY_BYTES, SESSION_COOKIE, ceremony, journal, passkey, state_fault},
    token,
};
use crate::{
    fault::{Fault, Reply},
    http::{body, browser, respond},
    json::{self, Value},
    process::app::App,
    record::{AuthState, StateError},
};

/// The Admin origins that complete an OAuth authorization automatically.
const AUTOMATIC_OAUTH_ORIGINS: [&str; 2] = ["http://127.0.0.1:7777", "https://local.shimpz.com"];

async fn payload(request: Request) -> Result<(HeaderMap, Value), Fault> {
    let (parts, body) = request.into_parts();
    let payload = body::json_object(&parts.headers, body, MAX_BODY_BYTES).await?;
    Ok((parts.headers, payload))
}

fn answered(outcome: Result<Response, Fault>) -> Response {
    outcome.unwrap_or_else(|fault| respond::fault(&fault))
}

async fn ceremony_route<F, Fut>(app: Arc<App>, request: Request, run: F) -> Response
where
    F: FnOnce(Arc<App>, HeaderMap, Value) -> Fut,
    Fut: Future<Output = Result<Response, Fault>>,
{
    match payload(request).await {
        Ok((headers, payload)) => answered(run(app, headers, payload).await),
        Err(fault) => respond::fault(&fault),
    }
}

/// How Admin's page at an admitted `origin` completes an OAuth authorization, if it can.
fn oauth_completion_mode(app: &App, origin: &str) -> Result<Value, Fault> {
    if AUTOMATIC_OAUTH_ORIGINS.contains(&origin) {
        return Ok(json::text("automatic"));
    }
    let learned = app
        .store
        .browser_origin()
        .map_err(|error| state_fault(&error))?;
    if origin.starts_with("https://") && learned.as_deref() == Some(origin) {
        return Ok(json::text("code"));
    }
    Ok(Value::Null)
}

fn evidence_fault(error: &StateError) -> Fault {
    match error {
        StateError::PasswordRecord => Fault::PasswordRecord,
        StateError::Authority => Fault::Authority,
        _ => Fault::Internal,
    }
}

fn signed_in_view(
    app: &App,
    headers: &HeaderMap,
    evidence: token::Evidence,
    view: &mut Value,
) -> Result<(), Fault> {
    let origin = canonical_origin(browser::header(headers, "origin"));
    let allowed = app.allowed_origins().map_err(|error| state_fault(&error))?;
    let admitted = origin
        .as_ref()
        .is_some_and(|origin| allowed.contains(origin));
    json::set(view, "origin_admitted", Value::Bool(admitted));
    json::set(
        view,
        "authentication_method",
        json::text(evidence.method.name()),
    );
    let origin = origin.as_deref();
    json::set(
        view,
        "passkey_enrollment_available",
        Value::Bool(passkey::enrollment_available(app, origin)?),
    );
    json::set(
        view,
        "passkey_registered",
        Value::Bool(passkey::registered(app, origin)?),
    );
    if admitted {
        json::set(
            view,
            "oauth_completion_mode",
            oauth_completion_mode(app, origin.unwrap_or_default())?,
        );
    }
    Ok(())
}

fn session_view(app: &App, headers: &HeaderMap) -> Result<Value, Fault> {
    let state = app
        .store
        .classified_authentication_state()
        .map_err(|error| state_fault(&error))?;
    let mut view = json::object(vec![
        ("profile", json::text("local")),
        ("authenticated", Value::Bool(false)),
        (
            "initialized",
            Value::Bool(state != AuthState::Uninitialized),
        ),
        ("authentication_state", json::text(state.name())),
    ]);
    if state == AuthState::RecoveryRequired {
        return Ok(view);
    }
    let cookie = browser::cookie(headers, SESSION_COOKIE).unwrap_or_default();
    let evidence = app
        .session_evidence(&cookie, false)
        .map_err(|error| evidence_fault(&error))?;
    if let Some(evidence) = evidence {
        json::set(&mut view, "authenticated", Value::Bool(true));
        signed_in_view(app, headers, evidence, &mut view)?;
    }
    Ok(view)
}

/// `POST /api/session`: the Supervisor's authentication state and, when signed in, what this page may do.
pub async fn session(State(app): State<Arc<App>>, request: Request) -> Response {
    respond::outcome(session_view(&app, request.headers()).map(Reply::ok))
}

/// `POST /api/login`.
pub async fn login(State(app): State<Arc<App>>, request: Request) -> Response {
    ceremony_route(app, request, |app, headers, payload| async move {
        ceremony::login(&app, &headers, &payload).await
    })
    .await
}

fn logout_now(app: &App, headers: &HeaderMap) -> Result<Response, Fault> {
    let session = browser::cookie(headers, SESSION_COOKIE).unwrap_or_default();
    let raw = browser::header(headers, "origin");
    let origin = canonical_origin(raw);
    if let Some(raw) = raw {
        let allowed = app.allowed_origins().map_err(|error| state_fault(&error))?;
        if origin.as_deref() != Some(raw) || !allowed.iter().any(|known| known == raw) {
            return Err(Fault::detail(403, "logout origin is not admitted"));
        }
    }
    if !session.is_empty() {
        let secret = local::session_secret(app)?;
        if token::verify(&app.sessions, &app.clock, &secret, &session, false).is_some() {
            journal(app, "logout", Journaled::Ok, origin.as_deref(), None)
                .map_err(|error| state_fault(&error))?;
        }
        match app
            .store
            .revoke_sessions_for_logout(&app.sessions, &session)
        {
            Ok(_) => {}
            Err(StateError::Io) => {
                local::log("error", "session_revocation_unavailable");
                let body = json::object(vec![
                    ("ok", Value::Bool(false)),
                    (
                        "detail",
                        json::text("Local session revocation is unavailable"),
                    ),
                ]);
                return Ok(respond::json_response(503, &body));
            }
            Err(error) => return Err(state_fault(&error)),
        }
        app.domains.integrations.handoffs.cancel_session(&session);
    }
    let mut response = respond::json_response(200, &json::object(vec![("ok", Value::Bool(true))]));
    respond::delete_cookie(&mut response, SESSION_COOKIE, "/");
    Ok(response)
}

/// `POST /api/logout`: ends every session when the presented one is current.
pub async fn logout(State(app): State<Arc<App>>, request: Request) -> Response {
    answered(logout_now(&app, request.headers()))
}

/// `POST /api/admin/setup`.
pub async fn setup(State(app): State<Arc<App>>, request: Request) -> Response {
    let _held = app.domains.signin.setup.lock().await;
    ceremony_route(
        Arc::clone(&app),
        request,
        |app, headers, payload| async move { ceremony::setup(&app, &headers, &payload).await },
    )
    .await
}

/// `POST /api/admin/setup/totp`.
pub async fn setup_totp(State(app): State<Arc<App>>, request: Request) -> Response {
    let _held = app.domains.signin.setup.lock().await;
    ceremony_route(Arc::clone(&app), request, |app, headers, payload| async move {
        ceremony::confirm_setup(&app, &headers, &payload).await
    })
    .await
}

/// `POST /api/login/totp`.
pub async fn login_totp(State(app): State<Arc<App>>, request: Request) -> Response {
    ceremony_route(app, request, |app, headers, payload| async move {
        ceremony::confirm_login_totp(&app, &headers, &payload)
    })
    .await
}

/// `POST /api/login/passkey`.
pub async fn login_passkey(State(app): State<Arc<App>>, request: Request) -> Response {
    ceremony_route(app, request, |app, headers, payload| async move {
        ceremony::confirm_login_passkey(&app, &headers, &payload)
    })
    .await
}

/// `POST /api/login/recovery`.
pub async fn login_recovery(State(app): State<Arc<App>>, request: Request) -> Response {
    let _held = app.domains.signin.setup.lock().await;
    ceremony_route(
        Arc::clone(&app),
        request,
        |app, headers, payload| async move {
            ceremony::confirm_login_recovery(&app, &headers, &payload).await
        },
    )
    .await
}

/// `POST /api/login/recovery/totp`.
pub async fn recovery_totp(State(app): State<Arc<App>>, request: Request) -> Response {
    let _held = app.domains.signin.setup.lock().await;
    ceremony_route(
        Arc::clone(&app),
        request,
        |app, headers, payload| async move {
            ceremony::confirm_recovery_enrollment(&app, &headers, &payload).await
        },
    )
    .await
}

/// `POST /api/admin/passkeys/registration`.
pub async fn passkey_registration(State(app): State<Arc<App>>, request: Request) -> Response {
    ceremony_route(app, request, |app, headers, payload| async move {
        ceremony::begin_passkey_registration(&app, &headers, &payload)
    })
    .await
}

/// `POST /api/admin/passkeys`.
pub async fn passkey_registered(State(app): State<Arc<App>>, request: Request) -> Response {
    ceremony_route(app, request, |app, headers, payload| async move {
        ceremony::complete_passkey_registration(&app, &headers, &payload)
    })
    .await
}
