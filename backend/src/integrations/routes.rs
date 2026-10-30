//! OAuth's browser redirects: the start route that consumes one handoff on the callback's own host, and the platform
//! callback that completes the authorization with Team. Both always return to the token-free Chat URL.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, header},
    response::Response,
};

use super::authorization::LOCAL_DOMAIN_ORIGIN;
use crate::{
    http::{
        browser,
        respond::{self, CookieAttributes},
    },
    process::app::App,
    process::command::log,
};

/// The callback binding cookie.
pub const OAUTH_COOKIE: &str = "shimpz_oauth_binding";
/// Its path.
pub const OAUTH_COOKIE_PATH: &str = "/api/oauth/cloudflare";
/// Its lifetime.
pub const OAUTH_COOKIE_TTL: i64 = 300;

fn private(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// Back to the token-free Chat URL after discarding the OAuth browser binding.
fn chat_redirect(failure: &str) -> Response {
    let location = if failure.is_empty() {
        "/chat".to_owned()
    } else {
        format!("/chat?oauth={failure}")
    };
    let mut response = respond::see_other(&location);
    respond::delete_cookie(&mut response, OAUTH_COOKIE, OAUTH_COOKIE_PATH);
    private(response)
}

/// The callback mode this request's own host completes, if any.
fn request_mode(app: &App, request: &Request) -> Option<&'static str> {
    let host = browser::header(request.headers(), "host")?.to_ascii_lowercase();
    if host == "127.0.0.1:7777" {
        return Some("loopback");
    }
    let learned = app.store.browser_origin().ok().flatten();
    (host == "local.shimpz.com" && learned.as_deref() == Some(LOCAL_DOMAIN_ORIGIN))
        .then_some("local-domain")
}

/// The query's fields as `parse_qsl(keep_blank_values=True)` reads them.
fn query(request: &Request) -> Vec<(String, String)> {
    let decode = |text: &str| {
        percent_encoding::percent_decode_str(&text.replace('+', " "))
            .decode_utf8_lossy()
            .into_owned()
    };
    request
        .uri()
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|field| !field.is_empty())
        .map(|field| {
            let (name, value) = field.split_once('=').unwrap_or((field, ""));
            (decode(name), decode(value))
        })
        .collect()
}

/// `GET /api/oauth/cloudflare/start?handoff=…`: consume the handoff and send the browser to the provider.
pub async fn oauth_start(State(app): State<Arc<App>>, request: Request) -> Response {
    let handoff = query(&request)
        .into_iter()
        .rev()
        .find(|(name, _)| name == "handoff")
        .map(|(_, value)| value)
        .unwrap_or_default();
    let handoffs = &app.domains.integrations.handoffs;
    let Some(mode) = request_mode(&app, &request) else {
        handoffs.discard(&handoff);
        return chat_redirect("start-failed");
    };
    let Ok(pending) = handoffs.consume(&handoff, mode) else {
        return chat_redirect("start-failed");
    };
    let domain = pending.callback_mode == "local-domain";
    let mut response = respond::see_other(&pending.authorization_url);
    respond::set_cookie(
        &mut response,
        &respond::cookie(
            OAUTH_COOKIE,
            &pending.session_binding,
            CookieAttributes {
                max_age: OAUTH_COOKIE_TTL,
                path: OAUTH_COOKIE_PATH,
                http_only: true,
                same_site: if domain { "none" } else { "lax" },
                secure: domain,
            },
        ),
    );
    private(response)
}

/// `GET /api/oauth/cloudflare/callback?state=…&claim=…`: complete the authorization with Team.
pub async fn oauth_callback(State(app): State<Arc<App>>, request: Request) -> Response {
    if request_mode(&app, &request).is_none() {
        return chat_redirect("callback-failed");
    }
    let pairs = query(&request);
    let mut names: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    if names != ["claim", "state"] {
        return chat_redirect("callback-failed");
    }
    let field = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map_or("", |(_, value)| value.as_str())
    };
    let binding = browser::cookie(request.headers(), OAUTH_COOKIE).unwrap_or_default();
    let team = app.machine_team();
    match super::assistants::complete_callback(
        &team,
        &app.topics,
        field("state"),
        field("claim"),
        &binding,
    )
    .await
    {
        Ok(result) if result.status == 200 => chat_redirect(""),
        Ok(_) => {
            log("info", "oauth_callback_rejected");
            chat_redirect("callback-failed")
        }
        Err(_) => chat_redirect("callback-failed"),
    }
}
