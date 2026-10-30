//! Exact-origin user-verified `WebAuthn` ceremonies for the Local Supervisor: the RP id an origin may use, the bounded one-process
//! challenges, the option documents a browser receives, and the stored credential's closed shape.

use std::{collections::HashMap, sync::Arc, sync::Mutex};

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use sha2::{Digest, Sha256};
use team_protocol::websocket::canonical_origin;

use crate::{
    json::{self, Value},
    sync::lock,
    time::clock::Clock,
};

/// A challenge lives this long.
pub const CHALLENGE_TTL_MS: i64 = 180 * 1000;
/// At most this many challenges are outstanding.
pub const CHALLENGE_CAPACITY: usize = 64;
/// The ceremony timeout the browser is given.
pub const CEREMONY_TIMEOUT_MS: i64 = 180 * 1000;
/// The most passkeys the Supervisor may hold.
pub const MAX_PASSKEYS: usize = 8;
/// The relying party's display name.
pub const RP_NAME: &str = "Shimpz";

/// Why a passkey ceremony or stored credential failed closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasskeyError {
    /// A stored passkey or option state is invalid.
    Invalid(&'static str),
    /// The exact origin cannot start the ceremony, or the response does not verify.
    Unavailable(&'static str),
    /// Credential or factor state changed during the ceremony.
    Conflict(&'static str),
}

impl PasskeyError {
    /// The error's message.
    #[must_use]
    pub const fn message(&self) -> &'static str {
        match self {
            Self::Invalid(message) | Self::Unavailable(message) | Self::Conflict(message) => {
                message
            }
        }
    }
}

/// Which ceremony a challenge is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ceremony {
    /// Signing in or confirming an operation.
    Authentication,
    /// Registering a new passkey.
    Registration,
}

/// One private, exact-ceremony challenge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Challenge {
    /// The 32 random challenge bytes.
    pub challenge: [u8; 32],
    /// The exact origin it was issued to.
    pub origin: String,
    /// The origin's RP id.
    pub rp_id: String,
    /// The factor generation it was issued under.
    pub generation: i64,
    /// When it expires on the monotonic clock.
    pub expires_at_ms: i64,
}

/// A verified assertion's credential state, committed atomically against its stored record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authentication {
    /// The credential id (unpadded base64url).
    pub credential_id: String,
    /// The authenticator's new signature counter.
    pub new_sign_count: i64,
    /// Whether the credential may be backed up.
    pub backup_eligible: bool,
    /// Whether the credential is backed up.
    pub backup_state: bool,
}

/// The exact-host RP id of one canonical WebAuthn-capable origin: `localhost` over HTTP, or an HTTPS domain host.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] for an IP address, another scheme, or a non-canonical origin.
pub fn rp_id_for_origin(origin: &str) -> Result<String, PasskeyError> {
    let refused = PasskeyError::Unavailable("passkeys are unavailable at this Admin address");
    if canonical_origin(Some(origin)).as_deref() != Some(origin) {
        return Err(refused);
    }
    let (scheme, netloc) = origin.split_once("://").ok_or(refused)?;
    if netloc.contains('@') {
        return Err(refused);
    }
    let hostname = netloc
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if hostname.is_empty() {
        return Err(refused);
    }
    if scheme == "http" && hostname == "localhost" {
        return Ok(hostname);
    }
    let is_ip = hostname.parse::<std::net::Ipv4Addr>().is_ok();
    let is_domain = !is_ip && (hostname.contains('.') || hostname == "localhost");
    if scheme != "https" || !is_domain {
        return Err(refused);
    }
    Ok(hostname)
}

/// The bounded one-process challenge authority, keyed by the digest of the private evidence it binds to.
pub struct Challenges {
    clock: Arc<Clock>,
    records: Mutex<HashMap<(Vec<u8>, Ceremony), Challenge>>,
}

fn binding_key(value: &str) -> Result<Vec<u8>, PasskeyError> {
    if !(32..=512).contains(&value.len()) || !value.is_ascii() {
        return Err(PasskeyError::Unavailable("passkey ceremony is unavailable"));
    }
    Ok(Sha256::digest(value.as_bytes()).to_vec())
}

impl Challenges {
    /// No challenge yet.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            records: Mutex::new(HashMap::new()),
        }
    }

    /// Issues the one challenge of `binding` and `ceremony` at `origin`, replacing an earlier one.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError`] for an origin without an RP id, an invalid binding, or a full store.
    pub fn issue(
        &self,
        binding: &str,
        ceremony: Ceremony,
        origin: &str,
        generation: i64,
    ) -> Result<Challenge, PasskeyError> {
        let rp_id = rp_id_for_origin(origin)?;
        let key = (binding_key(binding)?, ceremony);
        let now = self.clock.monotonic_ms();
        let mut records = lock(&self.records);
        records.retain(|_, challenge| challenge.expires_at_ms > now);
        if !records.contains_key(&key) && records.len() >= CHALLENGE_CAPACITY {
            return Err(PasskeyError::Unavailable(
                "passkey challenge capacity reached",
            ));
        }
        let challenge = Challenge {
            challenge: crate::random::bytes::<32>(),
            origin: origin.to_owned(),
            rp_id,
            generation,
            expires_at_ms: now + CHALLENGE_TTL_MS,
        };
        records.insert(key, challenge.clone());
        Ok(challenge)
    }

    /// Takes the challenge of `binding` and `ceremony` once.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError::Unavailable`] when none is current.
    pub fn consume(&self, binding: &str, ceremony: Ceremony) -> Result<Challenge, PasskeyError> {
        let key = (binding_key(binding)?, ceremony);
        let now = self.clock.monotonic_ms();
        let challenge = {
            let mut records = lock(&self.records);
            records.retain(|_, challenge| challenge.expires_at_ms > now);
            records.remove(&key)
        };
        challenge
            .filter(|challenge| challenge.expires_at_ms > now)
            .ok_or(PasskeyError::Unavailable(
                "passkey challenge is unavailable",
            ))
    }

    /// Forgets every challenge after an authentication-state change.
    pub fn clear(&self) {
        lock(&self.records).clear();
    }
}

fn descriptors(records: &[Value]) -> Value {
    Value::Array(
        records
            .iter()
            .map(|record| {
                json::object(vec![
                    (
                        "id",
                        json::text(json::get_str(record, "credential_id").unwrap_or_default()),
                    ),
                    ("type", json::text("public-key")),
                ])
            })
            .collect(),
    )
}

/// The UV-required registration options of the singleton Supervisor, excluding its same-origin passkeys.
#[must_use]
pub fn registration_options(challenge: &Challenge, user_id_hex: &str, records: &[Value]) -> Value {
    let user_id = HEXLOWER.decode(user_id_hex.as_bytes()).unwrap_or_default();
    let algorithm = |alg: i64| {
        json::object(vec![
            ("type", json::text("public-key")),
            ("alg", json::int(alg)),
        ])
    };
    json::object(vec![
        (
            "rp",
            json::object(vec![
                ("name", json::text(RP_NAME)),
                ("id", json::text(&challenge.rp_id)),
            ]),
        ),
        (
            "user",
            json::object(vec![
                ("id", json::text(BASE64URL_NOPAD.encode(&user_id))),
                ("name", json::text("Supervisor")),
                ("displayName", json::text("Supervisor")),
            ]),
        ),
        (
            "challenge",
            json::text(BASE64URL_NOPAD.encode(&challenge.challenge)),
        ),
        (
            "pubKeyCredParams",
            Value::Array(vec![algorithm(-8), algorithm(-7), algorithm(-257)]),
        ),
        ("timeout", json::int(CEREMONY_TIMEOUT_MS)),
        ("excludeCredentials", descriptors(records)),
        (
            "authenticatorSelection",
            json::object(vec![
                ("residentKey", json::text("preferred")),
                ("requireResidentKey", Value::Bool(false)),
                ("userVerification", json::text("required")),
            ]),
        ),
        ("attestation", json::text("none")),
    ])
}

/// The UV-required assertion options of the active exact-origin passkeys.
///
/// # Errors
///
/// Returns [`PasskeyError::Unavailable`] when no passkey is registered at the origin.
pub fn authentication_options(
    challenge: &Challenge,
    records: &[Value],
) -> Result<Value, PasskeyError> {
    if records.is_empty() {
        return Err(PasskeyError::Unavailable(
            "no passkey is registered for this Admin address",
        ));
    }
    Ok(json::object(vec![
        (
            "challenge",
            json::text(BASE64URL_NOPAD.encode(&challenge.challenge)),
        ),
        ("timeout", json::int(CEREMONY_TIMEOUT_MS)),
        ("rpId", json::text(&challenge.rp_id)),
        ("allowCredentials", descriptors(records)),
        ("userVerification", json::text("required")),
    ]))
}

/// Whether `value` is a stored credential or key identifier: 1 to 1,024 base64url characters.
#[must_use]
pub fn identifier(value: &str) -> bool {
    (1..=1024).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests;
