//! Short-lived request-bound assertions: the Supervisor's (a human session or the host-reset authority) and the
//! Routine identity's (one leased run), each a compact JWS over canonical JSON v1 claims.

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use sha2::{Digest, Sha256};
use team_protocol::supervisor::{
    ASSERTION_AUDIENCE, ASSERTION_MAX_TTL_SECONDS, EMPTY_SHA256, JWT_HEADER, ROUTINE_AUDIENCE,
    ROUTINE_AUTHORITY, ROUTINE_JWT_HEADER, canonical_json, claims_json,
};

use super::identity::{LocalIdentity, SupervisorAuthorityError};
use crate::json::{self, Value};

/// The authority a Supervisor assertion names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorityKind {
    /// A human MFA session.
    Session,
    /// The release-bound host reset capability.
    HostReset,
}

impl AuthorityKind {
    /// The authority's wire name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::HostReset => "host-reset",
        }
    }
}

/// The exact Team request one assertion authorizes.
#[derive(Clone, Debug, PartialEq)]
pub struct RequestBinding {
    /// The HTTP method.
    pub method: String,
    /// The request path.
    pub path: String,
    /// The body claim (`none`, `json`, or `file`).
    pub body: Value,
    /// The model credential's provider and key digest.
    pub model: Option<Value>,
    /// The human assurance this request carries.
    pub assurance: Option<Value>,
    /// The decision key's digest.
    pub decision: Option<Value>,
}

fn sha256_hex(raw: &[u8]) -> String {
    HEXLOWER.encode(&Sha256::digest(raw))
}

/// The claim of an empty body.
#[must_use]
pub fn empty_body() -> Value {
    json::object(vec![
        ("kind", json::text("none")),
        ("length", json::int(0)),
        ("sha256", json::text(EMPTY_SHA256)),
    ])
}

/// The claim of a JSON body of exactly these bytes.
#[must_use]
pub fn json_body(raw: &[u8]) -> Value {
    json::object(vec![
        ("kind", json::text("json")),
        (
            "length",
            json::int(i64::try_from(raw.len()).unwrap_or(i64::MAX)),
        ),
        ("sha256", json::text(sha256_hex(raw))),
    ])
}

/// The claim of an uploaded file: its length, name, and media type (never a digest of its bytes).
#[must_use]
pub fn file_body(raw: &[u8], filename: &str, media_type: &str) -> Value {
    json::object(vec![
        ("kind", json::text("file")),
        (
            "length",
            json::int(i64::try_from(raw.len()).unwrap_or(i64::MAX)),
        ),
        ("filename", json::text(filename)),
        ("media_type", json::text(media_type)),
    ])
}

/// The model credential's binding: its provider and the digest of its key.
#[must_use]
pub fn model_binding(provider: &str, api_key: &str) -> Value {
    json::object(vec![
        ("provider", json::text(provider)),
        ("key_sha256", json::text(sha256_hex(api_key.as_bytes()))),
    ])
}

/// The decision key's binding, bound exactly as a model credential is.
#[must_use]
pub fn decision_binding(decision_key: &str) -> Value {
    json::object(vec![
        ("provider", json::text("typesafe")),
        (
            "key_sha256",
            json::text(sha256_hex(decision_key.as_bytes())),
        ),
    ])
}

fn header(fields: &[(&str, &str); 3]) -> Value {
    json::object(
        fields
            .iter()
            .map(|(key, value)| (*key, json::text(*value)))
            .collect(),
    )
}

fn segment(raw: &[u8]) -> String {
    BASE64URL_NOPAD.encode(raw)
}

struct Signing<'a> {
    authority: &'a str,
    authority_secret: &'a str,
    audience: &'a str,
    header: &'a [(&'a str, &'a str); 3],
}

fn sign(
    identity: &LocalIdentity,
    request: &RequestBinding,
    signing: &Signing<'_>,
    now: i64,
) -> Result<String, SupervisorAuthorityError> {
    let mut claims = vec![
        ("v", json::int(1)),
        ("aud", json::text(signing.audience)),
        ("sub", json::text(&identity.supervisor_id)),
        ("authority", json::text(signing.authority)),
        (
            "authority_sha256",
            json::text(sha256_hex(signing.authority_secret.as_bytes())),
        ),
        ("jti", json::text(crate::random::hex(16))),
        ("iat", json::int(now)),
        ("exp", json::int(now + ASSERTION_MAX_TTL_SECONDS)),
        ("method", json::text(&request.method)),
        ("path", json::text(&request.path)),
        ("body", request.body.clone()),
    ];
    for (name, binding) in [
        ("model", &request.model),
        ("decision", &request.decision),
        ("assurance", &request.assurance),
    ] {
        if let Some(binding) = binding {
            claims.push((name, binding.clone()));
        }
    }
    let header = canonical_json(&header(signing.header)).map_err(|_| SupervisorAuthorityError)?;
    let payload = claims_json(&json::object(claims), signing.audience)
        .map_err(|_| SupervisorAuthorityError)?;
    let signing_input = format!("{}.{}", segment(&header), segment(&payload));
    let signature = identity.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", segment(&signature)))
}

/// One canonical, short-lived Supervisor assertion for one exact Team request.
///
/// # Errors
///
/// Returns [`SupervisorAuthorityError`] when the claims fall outside the assertion contract.
pub fn sign_request(
    identity: &LocalIdentity,
    authority_secret: &str,
    kind: AuthorityKind,
    request: &RequestBinding,
    now: i64,
) -> Result<String, SupervisorAuthorityError> {
    sign(
        identity,
        request,
        &Signing {
            authority: kind.name(),
            authority_secret,
            audience: ASSERTION_AUDIENCE,
            header: &JWT_HEADER,
        },
        now,
    )
}

/// One Routine assertion: Admin's routine identity drives the run whose lease token it holds (ADR-0086).
///
/// # Errors
///
/// Returns [`SupervisorAuthorityError`] for a request that binds a model, decision, or assurance.
pub fn sign_routine_request(
    identity: &LocalIdentity,
    lease_token: &str,
    request: &RequestBinding,
    now: i64,
) -> Result<String, SupervisorAuthorityError> {
    if request.model.is_some() || request.decision.is_some() || request.assurance.is_some() {
        return Err(SupervisorAuthorityError);
    }
    sign(
        identity,
        request,
        &Signing {
            authority: ROUTINE_AUTHORITY,
            authority_secret: lease_token,
            audience: ROUTINE_AUDIENCE,
            header: &ROUTINE_JWT_HEADER,
        },
        now,
    )
}

#[cfg(test)]
mod tests;
