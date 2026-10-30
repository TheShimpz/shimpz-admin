//! The Supervisor gate in front of every `/api/` route: the SPA and the open ceremonies pass, every other API call
//! needs a current Supervisor session and, to change state, Admin's own page. The call then runs under that session's
//! authority, bound again from the current signing identity.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, header},
    middleware::Next,
    response::Response,
};
use zeroize::Zeroizing;

use super::{browser, respond};
use crate::{
    fault::Reply,
    json,
    process::app::{App, COOKIE},
    record::StateError,
    team::transport::Team,
};

/// The open API: the sign-in ceremonies, the session bootstrap, OAuth's browser redirects, and the host reset.
pub const OPEN_API: [&str; 12] = [
    "/api/session",
    "/api/login",
    "/api/logout",
    "/api/admin/setup",
    "/api/admin/setup/totp",
    "/api/login/totp",
    "/api/login/passkey",
    "/api/login/recovery",
    "/api/login/recovery/totp",
    "/api/oauth/cloudflare/start",
    "/api/oauth/cloudflare/callback",
    "/api/space/host",
];

/// The session socket: like every `WebSocket`, it authenticates itself as it opens.
pub const SOCKETS: [&str; 1] = [crate::session::frames::PATH];

/// The session cookie a gated call carries, for the route that needs it.
#[derive(Clone)]
pub struct SessionCookie(pub Arc<Zeroizing<String>>);

fn socket_path(path: &str) -> bool {
    SOCKETS.contains(&path)
        || (path.starts_with("/api/teams/")
            && (path.ends_with("/stream") || path.ends_with("/control"))
            && path.contains("/browser/views/"))
}

fn upgrade(request: &Request) -> bool {
    browser::header(request.headers(), "upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn secured(app: &App, mut response: Response) -> Response {
    browser::secure(
        response.headers_mut(),
        &app.site.script_sources,
        &app.socket_origins(),
    );
    response
}

fn refused(app: &App, reply: &Reply) -> Response {
    let mut response = respond::json_response(reply.status, &reply.body);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    secured(app, response)
}

fn password_recovery() -> Reply {
    Reply::new(
        503,
        json::object(vec![
            ("code", json::text("password-recovery-required")),
            (
                "detail",
                json::text("Supervisor password recovery is required"),
            ),
        ]),
    )
}

fn authority_unavailable() -> Reply {
    Reply::detail(503, "Supervisor authority is unavailable")
}

/// What the gate admits a call with, or the refusal that answers it.
fn admit(app: &App, request: &Request) -> Result<(Team, String), Reply> {
    let cookie = browser::cookie(request.headers(), COOKIE).unwrap_or_default();
    match app.session_evidence(&cookie, false) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(Reply::detail(401, "unauthenticated")),
        Err(StateError::PasswordRecord) => return Err(password_recovery()),
        Err(StateError::Authority) => return Err(authority_unavailable()),
        Err(_) => return Err(Reply::detail(500, "Internal Server Error")),
    }
    let origins = app
        .allowed_origins()
        .map_err(|_| Reply::detail(500, "Internal Server Error"))?;
    if !browser::admits_unsafe_request(request.method(), request.headers(), &origins) {
        return Err(Reply::detail(403, "browser origin is not admitted"));
    }
    let team = app
        .session_team(&cookie)
        .map_err(|_| authority_unavailable())?;
    Ok((team, cookie))
}

/// The gate.
pub async fn gate(State(app): State<Arc<App>>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if socket_path(&path) && upgrade(&request) {
        return next.run(request).await;
    }
    if !path.starts_with("/api/") || OPEN_API.contains(&path.as_str()) {
        let mut response = next.run(request).await;
        if path == "/api/session" || path == "/api/space/host" {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        if path == "/api/session" {
            response
                .headers_mut()
                .insert(header::VARY, HeaderValue::from_static("Origin"));
        }
        return secured(&app, response);
    }
    match admit(&app, &request) {
        Ok((team, cookie)) => {
            request.extensions_mut().insert(team);
            request
                .extensions_mut()
                .insert(SessionCookie(Arc::new(Zeroizing::new(cookie))));
            let response = next.run(request).await;
            secured(&app, response)
        }
        Err(reply) => refused(&app, &reply),
    }
}
