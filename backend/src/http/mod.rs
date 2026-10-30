//! Admin's HTTP surface: the open sign-in ceremonies and the single-page app, every other `/api/` route behind the
//! Supervisor gate,
//! and the three `WebSocket` endpoints.

pub mod body;
pub mod browser;
pub mod gate;
pub mod respond;
pub mod statics;

use std::sync::Arc;

use axum::{
    Router,
    extract::{Request, State},
    middleware,
    response::Response,
    routing::{MethodRouter, any, delete, get, post},
};
use tokio::net::TcpListener;

use crate::app::App;

/// What every route shares.
pub type Shared = State<Arc<App>>;

/// `/api/{path}` that names no route: never answered with the SPA, so a typo or retired endpoint fails honestly.
pub async fn unknown_api(request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let decoded = percent_encoding::percent_decode_str(&path)
        .decode_utf8_lossy()
        .into_owned();
    respond::json_response(
        404,
        &crate::json::detail(&format!("unknown API endpoint: {decoded}")),
    )
}

fn route(router: MethodRouter<Arc<App>>) -> MethodRouter<Arc<App>> {
    router.fallback(unknown_api)
}

async fn spa(State(app): Shared, request: Request) -> Response {
    let path = request.uri().path().trim_start_matches('/').to_owned();
    let decoded = percent_encoding::percent_decode_str(&path)
        .decode_utf8_lossy()
        .into_owned();
    app.site
        .serve(request.method(), &decoded, request.headers())
        .await
}

/// The sign-in ceremonies and the session bootstrap.
fn signin_routes() -> Router<Arc<App>> {
    use crate::signin;
    Router::new()
        .route("/api/session", route(post(signin::routes::session)))
        .route("/api/login", route(post(signin::routes::login)))
        .route("/api/logout", route(post(signin::routes::logout)))
        .route("/api/admin/setup", route(post(signin::routes::setup)))
        .route(
            "/api/admin/setup/totp",
            route(post(signin::routes::setup_totp)),
        )
        .route("/api/login/totp", route(post(signin::routes::login_totp)))
        .route(
            "/api/login/passkey",
            route(post(signin::routes::login_passkey)),
        )
        .route(
            "/api/login/recovery",
            route(post(signin::routes::login_recovery)),
        )
        .route(
            "/api/login/recovery/totp",
            route(post(signin::routes::recovery_totp)),
        )
        .route(
            "/api/admin/passkeys/registration",
            route(post(signin::routes::passkey_registration)),
        )
        .route(
            "/api/admin/passkeys",
            route(post(signin::routes::passkey_registered)),
        )
}

/// The Space, OAuth, Team resource, and `WebSocket` routes.
fn resource_routes() -> Router<Arc<App>> {
    use crate::{chat, integrations, session, space, team};
    Router::new()
        .route("/api/space", route(delete(space::routes::space_reset)))
        .route("/api/space/host", route(delete(space::routes::host_reset)))
        .route(
            "/api/oauth/cloudflare/start",
            route(get(integrations::routes::oauth_start)),
        )
        .route(
            "/api/oauth/cloudflare/callback",
            route(get(integrations::routes::oauth_callback)),
        )
        .route(
            "/api/teams/{team_id}/files",
            route(post(team::files::upload)),
        )
        .route(
            "/api/teams/{team_id}/files/{file_id}/preview",
            route(get(team::files::preview)),
        )
        .route(
            "/api/teams/{team_id}/files/{file_id}/pages/{page}/preview",
            route(get(team::files::page_preview)),
        )
        .route(
            "/api/teams/{team_id}/files/{file_id}/download",
            route(get(team::files::download)),
        )
        .route(
            "/api/teams/{team_id}/assistants/{assistant_id}/icon",
            route(get(team::assets::assistant_icon)),
        )
        .route(
            "/api/local-assistants/{image_hash}/icon",
            route(get(team::assets::local_assistant_icon)),
        )
        .route(
            "/api/assistants/{assistant_id}/catalog-icon",
            route(get(chat::assets::catalog_icon)),
        )
        .route(session::frames::PATH, route(get(session::socket::upgrade)))
        .route(
            "/api/teams/{team_id}/browser/views/{view_id}/stream",
            route(get(team::browser_view::stream)),
        )
        .route(
            "/api/teams/{team_id}/browser/views/{view_id}/control",
            route(get(team::browser_view::control)),
        )
}

/// Every route of the Admin API and its SPA.
pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .merge(signin_routes())
        .merge(resource_routes())
        .route("/api/", any(unknown_api))
        .route("/api/{*path}", any(unknown_api))
        .fallback(spa)
        .layer(middleware::from_fn_with_state(Arc::clone(&app), gate::gate))
        .with_state(app)
}

/// Serves Admin on `listener` until the process ends.
///
/// # Errors
///
/// Returns the server's I/O failure.
pub async fn serve(app: Arc<App>, listener: TcpListener) -> std::io::Result<()> {
    axum::serve(listener, router(app)).await
}
