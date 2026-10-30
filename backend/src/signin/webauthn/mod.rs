//! `WebAuthn` response verification for the Local Supervisor's passkeys.
//!
//! The Account verifier this ceremony reuses (ADR-0123, R6 debate) is not mirrored into Admin yet, so every
//! registration and assertion response is refused as invalid: no passkey can be registered or used until it is, and
//! TOTP stays the second factor. Only the credential identifier an assertion names is read, to select its record.

use super::passkeys::{Authentication, Challenge, PasskeyError, identifier};
use crate::json::{self, Value};

/// The bounded credential identifier one assertion names.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] for anything but an object naming one stored-identifier `id`.
pub fn credential_id(credential: &Value) -> Result<String, PasskeyError> {
    json::get_str(credential, "id")
        .filter(|id| identifier(id))
        .map(str::to_owned)
        .ok_or(PasskeyError::Unavailable("invalid passkey authentication"))
}

/// Verifies one assertion against its challenge and stored record.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`]: no verifier is mirrored yet.
pub const fn verify_authentication(
    _challenge: &Challenge,
    _credential: &Value,
    _record: &Value,
) -> Result<Authentication, PasskeyError> {
    Err(PasskeyError::Unavailable("invalid passkey authentication"))
}

/// Verifies one registration and returns the stored public record.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`]: no verifier is mirrored yet.
pub const fn verify_registration(
    _challenge: &Challenge,
    _credential: &Value,
    _now: i64,
) -> Result<Value, PasskeyError> {
    Err(PasskeyError::Unavailable("invalid passkey registration"))
}

#[cfg(test)]
mod tests;
