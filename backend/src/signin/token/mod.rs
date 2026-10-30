//! The Local Supervisor's `v3` session token: `v3:<issued_at>:<nonce>:pwd+<method>:<signature>`.
//!
//! The signature is HMAC-SHA256 of the first four fields under the store's `session_secret`; a session lasts at most a
//! day from its sign-in and ends after an hour without Supervisor activity, tracked only in this process.

use data_encoding::HEXLOWER;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::sessions::Sessions;
use crate::time::clock::Clock;

/// A session's absolute lifetime from its sign-in.
pub const TTL_SECONDS: i64 = 24 * 3600;
const SCHEME: &str = "v3";

/// The second factor that completed a session's sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// A TOTP code (or a recovery code's TOTP re-enrollment).
    Totp,
    /// A passkey.
    Webauthn,
}

impl Method {
    /// The method as the token and `/api/session` name it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Totp => "totp",
            Self::Webauthn => "webauthn",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "totp" => Some(Self::Totp),
            "webauthn" => Some(Self::Webauthn),
            _ => None,
        }
    }
}

/// Signed evidence of one completed MFA sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Evidence {
    /// When the sign-in completed (Unix seconds).
    pub issued_at: i64,
    /// Its second factor.
    pub method: Method,
}

impl Evidence {
    /// When the session ends whatever its activity.
    #[must_use]
    pub const fn expires_at(self) -> i64 {
        self.issued_at + TTL_SECONDS
    }
}

fn signature(secret_hex: &str, body: &str) -> Option<String> {
    let key = HEXLOWER.decode(secret_hex.as_bytes()).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(body.as_bytes());
    Some(HEXLOWER.encode(&mac.finalize().into_bytes()))
}

/// Mints and tracks one signed session token, valid for a day from `issued_at`.
#[must_use]
pub fn issue(sessions: &Sessions, secret_hex: &str, method: Method, issued_at: i64) -> String {
    let body = format!(
        "{SCHEME}:{issued_at}:{}:pwd+{}",
        crate::random::hex(8),
        method.name()
    );
    let token = format!(
        "{body}:{}",
        signature(secret_hex, &body).unwrap_or_default()
    );
    sessions.register(&token);
    token
}

/// The signed evidence a token carries under `secret_hex`, whatever its time or tracking.
#[must_use]
pub fn signed_evidence(secret_hex: &str, token: &str) -> Option<Evidence> {
    if secret_hex.is_empty() || token.is_empty() {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    let [scheme, issued, nonce, method, sig] = parts.as_slice() else {
        return None;
    };
    let method = method.strip_prefix("pwd+").and_then(Method::parse)?;
    if *scheme != SCHEME
        || sig.len() != 64
        || !sig
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let body = format!("{scheme}:{issued}:{nonce}:pwd+{}", method.name());
    let expected = signature(secret_hex, &body)?;
    if !bool::from(sig.as_bytes().ct_eq(expected.as_bytes()))
        || issued.is_empty()
        || !issued.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let issued_at = issued.parse::<i64>().ok()?;
    Some(Evidence { issued_at, method })
}

/// MFA evidence of an authentic, unexpired, tracked, and active session; `activity` (the Supervisor's own input)
/// restarts its idle time.
#[must_use]
pub fn verify(
    sessions: &Sessions,
    clock: &Clock,
    secret_hex: &str,
    token: &str,
    activity: bool,
) -> Option<Evidence> {
    let evidence = signed_evidence(secret_hex, token)?;
    let now = clock.now_ms();
    if !(evidence.issued_at.saturating_mul(1000) <= now
        && now < evidence.expires_at().saturating_mul(1000))
    {
        return None;
    }
    sessions.current(token, activity).then_some(evidence)
}

/// Milliseconds until a current session idles out unless it is active meanwhile, and until its absolute expiry.
#[must_use]
pub fn deadlines(
    sessions: &Sessions,
    clock: &Clock,
    secret_hex: &str,
    token: &str,
) -> Option<(i64, i64)> {
    let evidence = signed_evidence(secret_hex, token)?;
    let idle = sessions.idle_remaining_ms(token)?;
    Some((
        idle,
        (evidence.expires_at().saturating_mul(1000) - clock.now_ms()).max(0),
    ))
}

#[cfg(test)]
mod tests;
