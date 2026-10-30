//! Admin's HTTP answers: compact JSON as `FastAPI` writes it, its cookies, and the refusals a failure stands for.

use std::fmt::Write as _;

use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{
    fault::{Fault, Refusal, Reply},
    json::{self, Value},
};

/// A JSON answer of `status`.
#[must_use]
pub fn json_response(status: u16, body: &Value) -> Response {
    let mut response = Response::new(Body::from(json::compact(body)));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// A reply as its JSON answer.
#[must_use]
pub fn reply(reply: &Reply) -> Response {
    json_response(reply.status, &reply.body)
}

/// A reply as its JSON answer that is never cached.
#[must_use]
pub fn no_store(reply: &Reply) -> Response {
    let mut response = json_response(reply.status, &reply.body);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A refusal as `FastAPI` answers an `HTTPException`, with its `Retry-After`.
#[must_use]
pub fn refusal(refusal: &Refusal) -> Response {
    let mut response = json_response(refusal.status, &refusal.body);
    if let Some(seconds) = refusal.retry_after
        && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
    {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

/// A failure as Admin's HTTP gate answers it.
#[must_use]
pub fn fault(fault: &Fault) -> Response {
    match fault {
        Fault::Refused(refused) => refusal(refused),
        Fault::Audit => no_store(&fault.reply()),
        other => reply(&other.reply()),
    }
}

/// An operation's outcome as its answer.
#[must_use]
pub fn outcome(outcome: Result<Reply, Fault>) -> Response {
    match outcome {
        Ok(answer) => reply(&answer),
        Err(failure) => fault(&failure),
    }
}

/// The attributes of one `Set-Cookie`.
#[derive(Clone, Copy, Debug)]
pub struct CookieAttributes<'a> {
    /// `Max-Age`.
    pub max_age: i64,
    /// `Path`.
    pub path: &'a str,
    /// `HttpOnly`.
    pub http_only: bool,
    /// `SameSite`.
    pub same_site: &'a str,
    /// `Secure`.
    pub secure: bool,
}

/// One `Set-Cookie` value in Python's sorted attribute order.
#[must_use]
pub fn cookie(name: &str, value: &str, attributes: CookieAttributes<'_>) -> String {
    let mut cookie = format!("{name}={value}");
    if attributes.max_age == 0 {
        cookie.push_str("; expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
    if attributes.http_only {
        cookie.push_str("; HttpOnly");
    }
    let _ = write!(
        cookie,
        "; Max-Age={}; Path={}; SameSite={}",
        attributes.max_age, attributes.path, attributes.same_site
    );
    if attributes.secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Adds one `Set-Cookie` to `response`.
pub fn set_cookie(response: &mut Response, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
}

/// Deletes the cookie `name` at `path`, as `FastAPI` does.
pub fn delete_cookie(response: &mut Response, name: &str, path: &str) {
    set_cookie(
        response,
        &cookie(
            name,
            "\"\"",
            CookieAttributes {
                max_age: 0,
                path,
                http_only: false,
                same_site: "lax",
                secure: false,
            },
        ),
    );
}

/// A `303 See Other` to `location`.
#[must_use]
pub fn see_other(location: &str) -> Response {
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}
