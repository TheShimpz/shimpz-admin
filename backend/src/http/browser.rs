//! The browser boundary of the compiled Admin SPA and its same-origin API: the page policy, which requests come from
//! Admin's own page, and the request's cookies.

use axum::http::{HeaderMap, HeaderValue, Method};
use team_protocol::websocket::canonical_origin;

/// The Permissions-Policy every response carries.
pub const PERMISSIONS_POLICY: &str =
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()";
/// The Fetch Metadata destinations of Admin's own page loading an image (a script's read is `empty`).
pub const IMAGE_DESTINATIONS: [&str; 2] = ["image", "empty"];
/// The Fetch Metadata destinations of a download.
pub const DOWNLOAD_DESTINATIONS: [&str; 2] = ["empty", "document"];

fn values<'a>(headers: &'a HeaderMap, name: &str) -> Vec<&'a str> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().unwrap_or("\u{fffd}"))
        .collect()
}

/// The first value of a header, as text.
#[must_use]
pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The request's cookies, as Starlette parses its first `Cookie` header: the last value of a name wins.
#[must_use]
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = header(headers, "cookie")?;
    let mut found = None;
    for chunk in raw.split(';') {
        let (key, value) = chunk.split_once('=').unwrap_or(("", chunk));
        if key.trim() == name {
            found = Some(unquote(value.trim()));
        }
    }
    found
}

fn unquote(value: &str) -> String {
    if value.len() < 2 || !value.starts_with('"') || !value.ends_with('"') {
        return value.to_owned();
    }
    let inner = &value[1..value.len() - 1];
    let mut out = String::new();
    let mut characters = inner.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\'
            && let Some(next) = characters.next()
        {
            out.push(next);
            continue;
        }
        out.push(character);
    }
    out
}

/// Whether the browser says Admin's own page, at an origin Admin admits, sent this request: at most one
/// `Sec-Fetch-Site` (which must say `same-origin`) and one `Origin` (which must be exactly an admitted origin), and at
/// least one of them.
#[must_use]
pub fn from_admin_page(headers: &HeaderMap, admitted: &[String]) -> bool {
    let sites = values(headers, "sec-fetch-site");
    let origins = values(headers, "origin");
    if sites.len() > 1 || origins.len() > 1 || (sites.is_empty() && origins.is_empty()) {
        return false;
    }
    if sites.first().is_some_and(|site| *site != "same-origin") {
        return false;
    }
    match origins.first() {
        Some(origin) => {
            canonical_origin(Some(origin)).as_deref() == Some(*origin)
                && admitted.iter().any(|known| known == origin)
        }
        None => true,
    }
}

/// Whether a state-changing request comes from Admin's own page (CSRF); a safe method always passes.
#[must_use]
pub fn admits_unsafe_request(method: &Method, headers: &HeaderMap, admitted: &[String]) -> bool {
    !matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) || from_admin_page(headers, admitted)
}

/// Whether Admin's own page fetches this as one of `destinations`: exactly one `Sec-Fetch-Site: same-origin` and one
/// `Sec-Fetch-Dest` among them.
#[must_use]
pub fn same_origin_fetch(headers: &HeaderMap, destinations: &[&str]) -> bool {
    let sites = values(headers, "sec-fetch-site");
    let fetched = values(headers, "sec-fetch-dest");
    sites == ["same-origin"] && fetched.len() == 1 && destinations.contains(&fetched[0])
}

/// The one exact canonical Origin of a request, if its first `Origin` header is one.
#[must_use]
pub fn request_origin(headers: &HeaderMap) -> Option<String> {
    canonical_origin(header(headers, "origin"))
}

fn socket_source(origin: &str) -> String {
    origin.strip_prefix("https").map_or_else(
        || format!("ws{}", origin.strip_prefix("http").unwrap_or(origin)),
        |rest| format!("wss{rest}"),
    )
}

/// The page policy bound to the compiled SPA's inline bootstrap scripts and Admin's admitted origins.
#[must_use]
pub fn content_security_policy(script_sources: &[String], admitted: &[String]) -> String {
    let mut sockets: Vec<String> = admitted
        .iter()
        .map(|origin| socket_source(origin))
        .collect();
    sockets.sort();
    let script = std::iter::once("'self'".to_owned())
        .chain(script_sources.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let connect = std::iter::once("'self'".to_owned())
        .chain(sockets)
        .collect::<Vec<_>>()
        .join(" ");
    [
        "default-src 'self'".to_owned(),
        "base-uri 'self'".to_owned(),
        "object-src 'none'".to_owned(),
        "frame-ancestors 'none'".to_owned(),
        "frame-src 'none'".to_owned(),
        "form-action 'self'".to_owned(),
        "img-src 'self' data: blob:".to_owned(),
        "font-src 'self'".to_owned(),
        format!("script-src {script}"),
        "style-src 'self' 'unsafe-inline'".to_owned(),
        format!("connect-src {connect}"),
        "require-trusted-types-for 'script'".to_owned(),
        "trusted-types svelte-trusted-html".to_owned(),
    ]
    .join("; ")
}

/// Applies the browser boundary to a response; a response's own policy stands.
pub fn secure(headers: &mut HeaderMap, script_sources: &[String], admitted: &[String]) {
    if !headers.contains_key("content-security-policy")
        && let Ok(value) = HeaderValue::from_str(&content_security_policy(script_sources, admitted))
    {
        headers.insert("content-security-policy", value);
    }
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(PERMISSIONS_POLICY),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}

#[cfg(test)]
mod tests;
