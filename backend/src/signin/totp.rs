//! Strict RFC 6238 enrollment and verification for the Local Supervisor.
//!
//! The factor is one stored object: its base32 secret, status (`pending` or `active`), the pending enrollment's
//! window, its consecutive-failure budget and lock, and the last accepted step, so no code is accepted twice.

use data_encoding::BASE32;
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;

use crate::json::{self, Value};

/// The TOTP period.
pub const PERIOD_SECONDS: i64 = 30;
/// The secret's length in bytes.
pub const SECRET_BYTES: usize = 20;
/// How long a pending enrollment waits for its first code.
pub const ENROLLMENT_TTL_SECONDS: i64 = 15 * 60;
/// Consecutive refused codes before the first lock.
pub const FAILURE_LIMIT: i64 = 5;
/// The first lock; each later refusal doubles it.
pub const LOCK_SECONDS: i64 = 5 * 60;
/// The longest lock.
pub const MAX_LOCK_SECONDS: i64 = 4 * 3600;
/// The failure count saturates here.
pub const MAX_FAILURES: i64 = 1_000_000;

const FIELDS: [&str; 9] = [
    "status",
    "secret",
    "created_at",
    "resumed_at",
    "expires_at",
    "failures",
    "locked_until",
    "last_accepted_step",
    "activated_at",
];

/// The stored factor is not the exact current contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TotpStateError;

/// The outcome of one persisted attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    /// The code is current and new.
    Accepted,
    /// The code is wrong, reused, or malformed.
    Invalid,
    /// The factor is locked after repeated refusals.
    Locked,
    /// The pending enrollment expired.
    Expired,
    /// The factors changed since the password ticket was issued; nothing was evaluated or counted.
    Changed,
}

/// One resumable enrollment as the browser sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enrollment {
    /// The base32 secret.
    pub secret: String,
    /// Its `otpauth://` URI.
    pub uri: String,
}

fn int(value: Option<&Value>) -> Option<i64> {
    value.and_then(json::as_int)
}

fn decode_secret(value: Option<&Value>) -> Result<Vec<u8>, TotpStateError> {
    let secret = value.and_then(json::as_str).ok_or(TotpStateError)?;
    if secret.len() != 32
        || !secret
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'2'..=b'7'))
    {
        return Err(TotpStateError);
    }
    let decoded = BASE32
        .decode(secret.as_bytes())
        .map_err(|_| TotpStateError)?;
    if decoded.len() == SECRET_BYTES {
        Ok(decoded)
    } else {
        Err(TotpStateError)
    }
}

fn hotp(secret: &[u8], step: i64) -> String {
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(secret) else {
        return String::new();
    };
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let value = u32::from_be_bytes([
        digest[offset],
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]) & 0x7fff_ffff;
    format!("{:06}", value % 1_000_000)
}

/// One pending current-contract factor created at `now`.
#[must_use]
pub fn new_record(now: i64) -> Value {
    let secret = BASE32.encode(&crate::random::bytes::<SECRET_BYTES>());
    json::object(vec![
        ("status", json::text("pending")),
        ("secret", json::text(secret)),
        ("created_at", json::int(now)),
        ("resumed_at", json::int(now)),
        ("expires_at", json::int(now + ENROLLMENT_TTL_SECONDS)),
        ("failures", json::int(0)),
        ("locked_until", Value::Null),
        ("last_accepted_step", Value::Null),
        ("activated_at", Value::Null),
    ])
}

fn nullable_int(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null)) || int(value).is_some()
}

/// Validates one stored factor.
///
/// # Errors
///
/// Returns [`TotpStateError`] for any factor outside the exact current contract.
pub fn validated(record: &Value) -> Result<(), TotpStateError> {
    if !json::has_exactly(record, &FIELDS) {
        return Err(TotpStateError);
    }
    decode_secret(record.get("secret"))?;
    let status = json::get_str(record, "status");
    let created = int(record.get("created_at")).ok_or(TotpStateError)?;
    let resumed = int(record.get("resumed_at")).ok_or(TotpStateError)?;
    let failures = int(record.get("failures")).ok_or(TotpStateError)?;
    if !matches!(status, Some("pending" | "active"))
        || created < PERIOD_SECONDS
        || resumed < created
        || !(0..=MAX_FAILURES).contains(&failures)
        || !nullable_int(record.get("locked_until"))
        || !nullable_int(record.get("last_accepted_step"))
    {
        return Err(TotpStateError);
    }
    let expires = record.get("expires_at");
    let activated = record.get("activated_at");
    if status == Some("pending") {
        if int(expires) != Some(resumed + ENROLLMENT_TTL_SECONDS)
            || !matches!(record.get("last_accepted_step"), Some(Value::Null))
            || !matches!(activated, Some(Value::Null))
        {
            return Err(TotpStateError);
        }
    } else if !matches!(expires, Some(Value::Null)) || int(activated).is_none_or(|at| at < created)
    {
        return Err(TotpStateError);
    }
    Ok(())
}

/// The enrollment state a strict factor puts the Supervisor in: `enrollment-required` or `configured`.
///
/// # Errors
///
/// Returns [`TotpStateError`] for an invalid factor.
pub fn state(record: &Value) -> Result<&'static str, TotpStateError> {
    validated(record)?;
    Ok(if json::get_str(record, "status") == Some("pending") {
        "enrollment-required"
    } else {
        "configured"
    })
}

/// The pending secret, without inventing a username or leaking an origin.
///
/// # Errors
///
/// Returns [`TotpStateError`] for an invalid or already active factor.
pub fn enrollment(record: &Value) -> Result<Enrollment, TotpStateError> {
    validated(record)?;
    if json::get_str(record, "status") != Some("pending") {
        return Err(TotpStateError);
    }
    let secret = json::get_str(record, "secret")
        .unwrap_or_default()
        .to_owned();
    let uri = format!(
        "otpauth://totp/Shimpz%20Supervisor?secret={secret}&issuer=Shimpz&digits=6&period=30"
    );
    Ok(Enrollment { secret, uri })
}

/// Resumes the same pending secret inside a fresh bounded confirmation window.
///
/// # Errors
///
/// Returns [`TotpStateError`] for an invalid or active factor.
pub fn resume(record: &mut Value, now: i64) -> Result<Enrollment, TotpStateError> {
    validated(record)?;
    if json::get_str(record, "status") != Some("pending") {
        return Err(TotpStateError);
    }
    json::set(record, "resumed_at", json::int(now));
    json::set(
        record,
        "expires_at",
        json::int(now + ENROLLMENT_TTL_SECONDS),
    );
    enrollment(record)
}

fn matched_step(secret: &[u8], code: &Value, now: i64) -> Option<i64> {
    let code = json::as_str(code)?;
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let current = now.div_euclid(PERIOD_SECONDS);
    let mut matched = None;
    for step in current - 1..=current + 1 {
        if bool::from(code.as_bytes().ct_eq(hotp(secret, step).as_bytes())) {
            matched = Some(step);
        }
    }
    matched
}

/// How long `failures` consecutive refused codes lock the factor: not at all below the limit, then doubling.
#[must_use]
pub fn lock_seconds(failures: i64) -> i64 {
    if failures < FAILURE_LIMIT {
        return 0;
    }
    let shift = u32::try_from((failures - FAILURE_LIMIT).min(16)).unwrap_or(16);
    (LOCK_SECONDS << shift).min(MAX_LOCK_SECONDS)
}

/// Counts one refused code, locking the factor once the budget is spent.
pub fn record_failure(record: &mut Value, now: i64) -> Verification {
    let failures = (int(record.get("failures")).unwrap_or(0) + 1).min(MAX_FAILURES);
    json::set(record, "failures", json::int(failures));
    let seconds = lock_seconds(failures);
    if seconds > 0 {
        json::set(record, "locked_until", json::int(now + seconds));
        return Verification::Locked;
    }
    Verification::Invalid
}

/// Whether the factor's consecutive-failure lock still holds at `now`.
#[must_use]
pub fn locked(record: &Value, now: i64) -> bool {
    int(record.get("locked_until")).is_some_and(|until| until > now)
}

/// Persists one attempt's replay and failure evidence into a validated factor.
///
/// # Errors
///
/// Returns [`TotpStateError`] for an invalid factor.
pub fn verify(record: &mut Value, code: &Value, now: i64) -> Result<Verification, TotpStateError> {
    validated(record)?;
    if json::get_str(record, "status") == Some("pending")
        && now > int(record.get("expires_at")).unwrap_or(0)
    {
        return Ok(Verification::Expired);
    }
    if locked(record, now) {
        return Ok(Verification::Locked);
    }
    let secret = decode_secret(record.get("secret"))?;
    let matched = matched_step(&secret, code, now);
    let last = int(record.get("last_accepted_step"));
    let Some(step) = matched.filter(|step| last.is_none_or(|last| *step > last)) else {
        return Ok(record_failure(record, now));
    };
    json::set(record, "last_accepted_step", json::int(step));
    json::set(record, "failures", json::int(0));
    json::set(record, "locked_until", Value::Null);
    if json::get_str(record, "status") == Some("pending") {
        json::set(record, "status", json::text("active"));
        json::set(record, "expires_at", Value::Null);
        json::set(record, "activated_at", json::int(now));
    }
    Ok(Verification::Accepted)
}

/// The current code of `secret` (base32) at `now`, for tests and fixtures.
#[must_use]
pub fn code_at(secret: &str, now: i64) -> String {
    let decoded = BASE32.decode(secret.as_bytes()).unwrap_or_default();
    hotp(&decoded, now.div_euclid(PERIOD_SECONDS))
}

#[cfg(test)]
mod tests;
