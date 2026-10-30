//! The exact authentication state a stored record is in, and the strict shapes its factors keep.

use super::{StateError, Store};
use crate::{
    json::{self, Value},
    signin::{
        passkeys::{self, MAX_PASSKEYS, PasskeyError, rp_id_for_origin},
        password, recovery, totp,
    },
};

/// The store's authentication-record version.
pub const AUTH_VERSION: i64 = 1;
/// Both refused-attempt counters saturate here.
pub const MAX_SECOND_FACTOR_FAILURES: i64 = 1_000_000;
/// At most this many consumed host reset capabilities are remembered.
pub const MAX_CONSUMED_HOST_RESETS: usize = 128;

const PASSKEY_FIELDS: [&str; 11] = [
    "credential_id",
    "public_key",
    "sign_count",
    "backup_eligible",
    "backup_state",
    "rp_id",
    "origin",
    "status",
    "created_at",
    "updated_at",
    "last_used_at",
];

/// The exact authentication state of the Local Supervisor's record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthState {
    /// No password: the bootstrap window is open.
    Uninitialized,
    /// A password with its first TOTP enrollment still pending.
    EnrollmentRequired,
    /// A password and an active TOTP factor.
    Configured,
    /// A recovery code replaced TOTP; only its re-enrollment is admitted (internal: discovery calls it configured).
    RecoveryEnrollment,
    /// The record is outside the current contract; only bounded capability recovery remains.
    RecoveryRequired,
}

impl AuthState {
    /// The state's name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Uninitialized => "uninitialized",
            Self::EnrollmentRequired => "enrollment-required",
            Self::Configured => "configured",
            Self::RecoveryEnrollment => "recovery-enrollment",
            Self::RecoveryRequired => "recovery-required",
        }
    }
}

fn hex(value: Option<&Value>, length: usize) -> bool {
    value.and_then(json::as_str).is_some_and(|text| {
        text.len() == length
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn non_negative(value: &Value) -> Option<i64> {
    json::as_int(value).filter(|number| *number >= 0)
}

/// Validates one stored passkey, refusing any shape Admin does not write.
///
/// # Errors
///
/// Returns [`PasskeyError::Invalid`] for an invalid record.
pub fn validated_passkey(record: &Value) -> Result<(), PasskeyError> {
    let invalid = PasskeyError::Invalid("stored passkey is invalid");
    if !json::has_exactly(record, &PASSKEY_FIELDS) {
        return Err(invalid);
    }
    let field = |name: &str| record.get(name).unwrap_or(&Value::Null);
    let identifier = |name: &str| json::as_str(field(name)).is_some_and(passkeys::identifier);
    let flag = |name: &str| matches!(field(name), Value::Bool(_));
    let times: Vec<Option<i64>> = ["created_at", "updated_at", "last_used_at"]
        .iter()
        .map(|name| non_negative(field(name)))
        .collect();
    let backed_up = matches!(field("backup_state"), Value::Bool(true));
    let eligible = matches!(field("backup_eligible"), Value::Bool(true));
    let (Some(created), Some(updated), Some(used)) = (times[0], times[1], times[2]) else {
        return Err(invalid);
    };
    if !identifier("credential_id")
        || !identifier("public_key")
        || non_negative(field("sign_count")).is_none()
        || !flag("backup_eligible")
        || !flag("backup_state")
        || (backed_up && !eligible)
        || !matches!(json::as_str(field("status")), Some("active" | "suspended"))
        || created > updated
        || created > used
    {
        return Err(invalid);
    }
    let origin = json::as_str(field("origin"));
    let rp_id = json::as_str(field("rp_id"));
    match (origin, rp_id) {
        (Some(origin), Some(rp_id)) if rp_id_for_origin(origin).ok().as_deref() == Some(rp_id) => {
            Ok(())
        }
        _ => Err(PasskeyError::Invalid("stored passkey origin is invalid")),
    }
}

/// Validates the stored passkey list: at most eight, each valid, no credential twice.
///
/// # Errors
///
/// Returns [`PasskeyError::Invalid`] for an invalid list.
pub fn validated_passkeys(records: &Value) -> Result<&[Value], PasskeyError> {
    let records = json::as_array(records)
        .filter(|records| records.len() <= MAX_PASSKEYS)
        .ok_or(PasskeyError::Invalid("stored passkeys are invalid"))?;
    for record in records {
        validated_passkey(record)?;
    }
    let mut identifiers: Vec<&str> = records
        .iter()
        .filter_map(|record| json::get_str(record, "credential_id"))
        .collect();
    identifiers.sort_unstable();
    identifiers.dedup();
    if identifiers.len() == records.len() {
        Ok(records)
    } else {
        Err(PasskeyError::Invalid("stored passkeys are invalid"))
    }
}

fn second_factor_failures(record: Option<&Value>) -> Result<(), StateError> {
    let record = record.ok_or(StateError::Totp)?;
    if !json::has_exactly(record, &["since_sign_in", "unacknowledged"]) {
        return Err(StateError::Totp);
    }
    let valid = |name: &str| {
        record
            .get(name)
            .and_then(json::as_int)
            .is_some_and(|count| (0..=MAX_SECOND_FACTOR_FAILURES).contains(&count))
    };
    if valid("since_sign_in") && valid("unacknowledged") {
        Ok(())
    } else {
        Err(StateError::Totp)
    }
}

/// Validates the remembered host reset capabilities.
///
/// # Errors
///
/// Returns [`StateError::Corrupt`] for an invalid list.
pub fn consumed_host_resets(records: &Value) -> Result<Vec<(String, i64)>, StateError> {
    let records = json::as_array(records)
        .filter(|records| records.len() <= MAX_CONSUMED_HOST_RESETS)
        .ok_or(StateError::Corrupt)?;
    let mut seen: Vec<(String, i64)> = Vec::with_capacity(records.len());
    for record in records {
        let digest = json::get_str(record, "digest").filter(|_| hex(record.get("digest"), 64));
        let expires = record
            .get("expires_at")
            .and_then(json::as_int)
            .filter(|at| *at >= 1);
        match (
            json::has_exactly(record, &["digest", "expires_at"]),
            digest,
            expires,
        ) {
            (true, Some(digest), Some(expires))
                if !seen.iter().any(|(known, _)| known == digest) =>
            {
                seen.push((digest.to_owned(), expires));
            }
            _ => return Err(StateError::Corrupt),
        }
    }
    Ok(seen)
}

fn factor_state(factor: &str, data: &Value) -> Result<AuthState, StateError> {
    let codes = data
        .get("recovery_codes")
        .ok_or(StateError::PasswordRecord)?;
    if matches!(codes, Value::Null) {
        return if factor == "enrollment-required" {
            Ok(AuthState::EnrollmentRequired)
        } else {
            Err(StateError::PasswordRecord)
        };
    }
    recovery::validated(codes).map_err(|_| StateError::PasswordRecord)?;
    Ok(if factor == "enrollment-required" {
        AuthState::RecoveryEnrollment
    } else {
        AuthState::Configured
    })
}

/// The exact authentication state of `data`.
///
/// # Errors
///
/// Returns [`StateError::PasswordRecord`] for a record that needs bounded recovery, and [`StateError::Corrupt`] for
/// invalid host reset evidence.
pub fn authentication_state(data: &Value) -> Result<AuthState, StateError> {
    let set = password::password_set(data).map_err(|_| StateError::PasswordRecord)?;
    if !set {
        let members = json::members(data).unwrap_or_default();
        if members.iter().any(|(key, _)| key != "consumed_host_resets") {
            return Err(StateError::PasswordRecord);
        }
        if let Some(records) = data.get("consumed_host_resets") {
            consumed_host_resets(records)?;
        }
        return Ok(AuthState::Uninitialized);
    }
    let generation = data.get("factor_generation").and_then(json::as_int);
    if data.get("auth_version").and_then(json::as_int) != Some(AUTH_VERSION)
        || generation.is_none_or(|generation| generation < 1)
        || !hex(data.get("webauthn_user_id"), 64)
        || !hex(data.get("session_secret"), 64)
        || data.get("passkeys").and_then(json::as_array).is_none()
    {
        return Err(StateError::PasswordRecord);
    }
    validated_passkeys(data.get("passkeys").unwrap_or(&Value::Null))
        .map_err(|_| StateError::PasswordRecord)?;
    second_factor_failures(data.get("second_factor_failures"))
        .map_err(|_| StateError::PasswordRecord)?;
    let factor = totp::state(data.get("totp").unwrap_or(&Value::Null))
        .map_err(|_| StateError::PasswordRecord)?;
    factor_state(factor, data)
}

impl Store {
    /// The exact current authentication state.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::PasswordRecord`] for a record that needs bounded recovery, or a store error.
    pub fn authentication_state(&self) -> Result<AuthState, StateError> {
        authentication_state(&self.get()?)
    }

    /// The public state: an invalid record is `recovery-required`, and a recovery re-enrollment is `configured`
    /// (signing in again is its one way forward).
    ///
    /// # Errors
    ///
    /// Returns a store error other than an invalid record.
    pub fn classified_authentication_state(&self) -> Result<AuthState, StateError> {
        match self.authentication_state() {
            Err(StateError::PasswordRecord) => Ok(AuthState::RecoveryRequired),
            Ok(AuthState::RecoveryEnrollment) => Ok(AuthState::Configured),
            other => other,
        }
    }

    /// Whether any strict password record has closed the bootstrap window.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::PasswordRecord`] or a store error.
    pub fn is_initialized(&self) -> Result<bool, StateError> {
        password::password_set(&self.get()?).map_err(|_| StateError::PasswordRecord)
    }

    /// The current validated factor generation.
    ///
    /// # Errors
    ///
    /// Returns an invalid record or store error.
    pub fn factor_generation(&self) -> Result<i64, StateError> {
        let data = self.get()?;
        authentication_state(&data)?;
        Ok(data
            .get("factor_generation")
            .and_then(json::as_int)
            .unwrap_or(0))
    }

    /// The stable opaque `WebAuthn` user handle (64 hex digits).
    ///
    /// # Errors
    ///
    /// Returns an invalid record or store error.
    pub fn webauthn_user_id(&self) -> Result<String, StateError> {
        let data = self.get()?;
        authentication_state(&data)?;
        Ok(json::get_str(&data, "webauthn_user_id")
            .unwrap_or_default()
            .to_owned())
    }

    /// The session secret, or an empty string when none is set.
    ///
    /// # Errors
    ///
    /// Returns a store error.
    pub fn session_secret(&self) -> Result<String, StateError> {
        Ok(json::get_str(&self.get()?, "session_secret")
            .unwrap_or_default()
            .to_owned())
    }
}
