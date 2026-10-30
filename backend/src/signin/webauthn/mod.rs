//! `WebAuthn` response verification for the Local Supervisor's passkeys, by Account's verifier (ADR-0123, R6 debate)
//! mirrored into `vendor/webauthn`: the same strict rules (W1–W10) for Admin's own relying party, the ceremony's
//! exact-host RP ID and exact origin, and the Supervisor's 32-byte user handle.

use account_webauthn::verify::{self, Relying};
use data_encoding::BASE64URL_NOPAD;

use super::passkeys::{Authentication, Challenge, PasskeyError, identifier};
use crate::json::{self, Value};

const INVALID_AUTHENTICATION: PasskeyError =
    PasskeyError::Unavailable("invalid passkey authentication");
const INVALID_REGISTRATION: PasskeyError =
    PasskeyError::Unavailable("invalid passkey registration");
const STORED_INVALID: PasskeyError = PasskeyError::Invalid("stored passkey is invalid");

fn party<'a>(challenge: &'a Challenge, user_handle: &'a [u8]) -> Relying<'a> {
    Relying {
        rp_id: &challenge.rp_id,
        origin: &challenge.origin,
        user_handle,
    }
}

/// The bounded credential identifier one assertion names.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] for anything but an object naming one stored-identifier `id`.
pub fn credential_id(credential: &Value) -> Result<String, PasskeyError> {
    json::get_str(credential, "id")
        .filter(|id| identifier(id))
        .map(str::to_owned)
        .ok_or(INVALID_AUTHENTICATION)
}

/// Verifies one assertion against its challenge and the stored record it names, whose counter Admin checks when it
/// commits the result.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] for a refused response, or [`PasskeyError::Invalid`] for a stored key outside
/// every template.
pub fn verify_authentication(
    challenge: &Challenge,
    credential: &Value,
    record: &Value,
    user_handle: &[u8],
) -> Result<Authentication, PasskeyError> {
    let relying = party(challenge, user_handle);
    let assertion =
        verify::parse_assertion(credential, &relying).map_err(|_| INVALID_AUTHENTICATION)?;
    let stored = json::get_str(record, "public_key")
        .and_then(|key| BASE64URL_NOPAD.decode(key.as_bytes()).ok())
        .ok_or(STORED_INVALID)?;
    let state = verify::verify_assertion(&assertion, &challenge.challenge, &stored, &relying)
        .map_err(|error| match error {
            Ok(_) => INVALID_AUTHENTICATION,
            Err(_) => STORED_INVALID,
        })?;
    Ok(Authentication {
        credential_id: assertion.credential_id,
        new_sign_count: state.sign_count,
        backup_eligible: state.backup_eligible,
        backup_state: state.backup_state,
    })
}

/// Verifies one registration and returns the stored public record.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] for a refused response.
pub fn verify_registration(
    challenge: &Challenge,
    credential: &Value,
    user_handle: &[u8],
    now: i64,
) -> Result<Value, PasskeyError> {
    let registered = verify::verify_registration(
        credential,
        &challenge.challenge,
        &party(challenge, user_handle),
    )
    .map_err(|_| INVALID_REGISTRATION)?;
    Ok(json::object(vec![
        ("credential_id", json::text(registered.credential_id)),
        (
            "public_key",
            json::text(BASE64URL_NOPAD.encode(&registered.public_key)),
        ),
        ("sign_count", json::int(registered.state.sign_count)),
        (
            "backup_eligible",
            Value::Bool(registered.state.backup_eligible),
        ),
        ("backup_state", Value::Bool(registered.state.backup_state)),
        ("rp_id", json::text(&challenge.rp_id)),
        ("origin", json::text(&challenge.origin)),
        ("status", json::text("active")),
        ("created_at", json::int(now)),
        ("updated_at", json::int(now)),
        ("last_used_at", json::int(now)),
    ]))
}

#[cfg(test)]
mod tests;
