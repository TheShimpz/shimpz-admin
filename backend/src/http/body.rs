//! Admission of the JSON object a browser request carries, within its route's bound.

use axum::{body::Body, http::HeaderMap};
use http_body_util::BodyExt;

use super::browser;

/// The longest a request may take to deliver its body: no request holds a read open longer.
pub const READ_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
use crate::{
    fault::Fault,
    json::{self, Value},
};

/// Reads one JSON object of at most `max_bytes`: exactly `application/json`, an ASCII-digit `Content-Length` within
/// the bound when given, strict JSON (unique keys), and an object.
///
/// # Errors
///
/// Returns the route's own refusal: 415, 400, or 413.
pub async fn json_object(
    headers: &HeaderMap,
    body: Body,
    max_bytes: usize,
) -> Result<Value, Fault> {
    let content_type = browser::header(headers, "content-type")
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if content_type != "application/json" {
        return Err(Fault::detail(415, "content type must be application/json"));
    }
    if let Some(length) = headers.get("content-length") {
        let length = length.to_str().unwrap_or("x");
        if length.is_empty() || !length.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Fault::detail(400, "invalid content length"));
        }
        if length
            .parse::<u64>()
            .map_or(true, |length| length > max_bytes as u64)
        {
            return Err(Fault::detail(413, "request body too large"));
        }
    }
    let raw = read(body, max_bytes).await?;
    let payload =
        json::parse(&raw).map_err(|_| Fault::detail(400, "request body must be valid JSON"))?;
    if json::members(&payload).is_none() {
        return Err(Fault::detail(400, "request body must be a JSON object"));
    }
    Ok(payload)
}

/// The body's bytes, refusing more than `max_bytes` with 413 as soon as they arrive.
///
/// # Errors
///
/// Returns 413 beyond the bound, 408 when the body does not arrive within [`READ_DEADLINE`], or 400 when it cannot
/// be read.
pub async fn read(body: Body, max_bytes: usize) -> Result<Vec<u8>, Fault> {
    tokio::time::timeout(READ_DEADLINE, collect(body, max_bytes))
        .await
        .map_err(|_| Fault::detail(408, "request body was not received in time"))?
}

async fn collect(mut body: Body, max_bytes: usize) -> Result<Vec<u8>, Fault> {
    let mut raw = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Fault::detail(400, "request body must be valid JSON"))?;
        if let Ok(data) = frame.into_data() {
            raw.extend_from_slice(&data);
            if raw.len() > max_bytes {
                return Err(Fault::detail(413, "request body too large"));
            }
        }
    }
    Ok(raw)
}

/// The payload when it holds exactly `names`; any other body is the request's own 400.
///
/// # Errors
///
/// Returns 400 naming the fields a body must contain.
pub fn exact_fields<'a>(payload: &'a Value, names: &[&str]) -> Result<&'a Value, Fault> {
    if json::has_exactly(payload, names) {
        Ok(payload)
    } else {
        Err(Fault::detail(
            400,
            &format!("request body must contain only {}", names.join(" and ")),
        ))
    }
}
