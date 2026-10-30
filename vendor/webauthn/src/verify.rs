//! Registration and assertion verification (R4 design W1-W8). Every refusal of client input is a
//! [`CredentialError`]; a stored key outside every template is server state ([`StoredKeyInvalid`]).
//!
//! - W1/W2: exactly Developers' credential shape, every value strict unpadded base64url within Developers' bounds.
//! - W3: clientDataJSON is one strict JSON object of this ceremony, challenge, and origin; `crossOrigin` absent or
//!   false; other members ignored.
//! - W4: a canonical CBOR attestation object of exactly `fmt`, `attStmt`, `authData`, with the `none` statement or a
//!   packed self-attestation the credential key signed.
//! - W5: authenticator data names the RP, has presence and verification, never backup state without eligibility,
//!   and holds exactly what its flags announce.
//! - W7: signatures cover authenticatorData then SHA-256(clientDataJSON).
//! - W8: a userHandle is null or exactly the relying party's user handle.
//!
//! The relying party (its RP ID, its one exact origin, and its user handle) is the consumer's: Account's Creator
//! sign-in and the Local Admin's Supervisor each pass their own [`Relying`].

use ring::digest;
use strict_json::Value;
use subtle::ConstantTimeEq as _;

use super::{
    cbor::{self, Item},
    keys::{self, StoredKey},
};
use crate::encoding::unbase64url;

/// The relying party one ceremony runs for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Relying<'a> {
    /// The RP ID whose SHA-256 the authenticator data names.
    pub rp_id: &'a str,
    /// The one exact origin clientDataJSON must name.
    pub origin: &'a str,
    /// The user handle an assertion may name (or name none).
    pub user_handle: &'a [u8],
}
/// The longest credential id, in bytes.
pub const MAX_CREDENTIAL_ID_BYTES: usize = 1023;
const MAX_ID_CHARACTERS: usize = 2048;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;
const AUTH_DATA_BYTES: usize = 37;
const CREDENTIAL_ID_START: usize = 55;

/// The client's credential is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CredentialError;

/// A stored key is not one of the templates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredKeyInvalid;

/// The authenticator state Account keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthenticatorState {
    /// The signature counter.
    pub sign_count: i64,
    /// BE.
    pub backup_eligible: bool,
    /// BS.
    pub backup_state: bool,
}

/// A verified registration: the credential id, its stored key bytes, and its state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    /// The canonical base64url credential id.
    pub credential_id: String,
    /// The COSE key template bytes.
    pub public_key: Vec<u8>,
    /// The authenticator state.
    pub state: AuthenticatorState,
}

/// An assertion whose shape is admitted, awaiting its stored key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assertion {
    /// The credential id it names.
    pub credential_id: String,
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
    signature: Vec<u8>,
}

/// Strict unpadded base64url of 1 to `maximum` characters.
fn decode(value: Option<&Value>, maximum: usize) -> Result<Vec<u8>, CredentialError> {
    match value {
        Some(Value::String(text)) if (1..=maximum).contains(&text.len()) => {
            unbase64url(text, false).ok_or(CredentialError)
        }
        _ => Err(CredentialError),
    }
}

fn names(value: &Value) -> Option<Vec<&str>> {
    match value {
        Value::Object(members) => {
            let mut names: Vec<&str> = members.iter().map(|(name, _)| name.as_str()).collect();
            names.sort_unstable();
            Some(names)
        }
        _ => None,
    }
}

/// W1 and the response's exact member names: the credential id, its bytes, and the response.
fn shape<'a>(
    credential: &'a Value,
    members: &[&str],
) -> Result<(String, Vec<u8>, &'a Value), CredentialError> {
    let expected = [
        "authenticatorAttachment",
        "clientExtensionResults",
        "id",
        "rawId",
        "response",
        "type",
    ];
    if names(credential).as_deref() != Some(&expected[..]) {
        return Err(CredentialError);
    }
    let attachment_ok = match credential.get("authenticatorAttachment") {
        Some(Value::Null) => true,
        Some(Value::String(text)) => text == "platform" || text == "cross-platform",
        _ => false,
    };
    let Some(Value::String(id)) = credential.get("id") else {
        return Err(CredentialError);
    };
    if !attachment_ok
        || credential.get("clientExtensionResults") != Some(&Value::Object(Vec::new()))
        || credential.get("rawId") != credential.get("id")
        || credential.get("type") != Some(&Value::String("public-key".into()))
    {
        return Err(CredentialError);
    }
    let raw = decode(credential.get("id"), MAX_ID_CHARACTERS)?;
    let response = credential.get("response").ok_or(CredentialError)?;
    if raw.len() > MAX_CREDENTIAL_ID_BYTES || names(response).as_deref() != Some(members) {
        return Err(CredentialError);
    }
    Ok((id.clone(), raw, response))
}

fn client_data(
    json: &[u8],
    ceremony: &str,
    challenge: &[u8],
    origin: &str,
) -> Result<(), CredentialError> {
    let data = strict_json::parse(json).map_err(|_| CredentialError)?;
    if names(&data).is_none()
        || data.get("type") != Some(&Value::String(ceremony.into()))
        || data.get("origin") != Some(&Value::String(origin.into()))
        || !matches!(data.get("crossOrigin"), None | Some(Value::Bool(false)))
    {
        return Err(CredentialError);
    }
    let supplied = decode(data.get("challenge"), MAX_ID_CHARACTERS)?;
    if bool::from(supplied.ct_eq(challenge)) {
        Ok(())
    } else {
        Err(CredentialError)
    }
}

fn flags(data: &[u8], rp_id: &str) -> Result<u8, CredentialError> {
    let rp_hash = digest::digest(&digest::SHA256, rp_id.as_bytes());
    if data.len() < AUTH_DATA_BYTES || !bool::from(data[..32].ct_eq(rp_hash.as_ref())) {
        return Err(CredentialError);
    }
    let flags = data[32];
    if flags & FLAG_UP == 0
        || flags & FLAG_UV == 0
        || (flags & FLAG_BS != 0 && flags & FLAG_BE == 0)
    {
        return Err(CredentialError);
    }
    Ok(flags)
}

fn extensions_to_end(data: &[u8], start: usize, flags: u8) -> Result<(), CredentialError> {
    if flags & FLAG_ED == 0 {
        return if start == data.len() {
            Ok(())
        } else {
            Err(CredentialError)
        };
    }
    match cbor::item(data.get(start..).ok_or(CredentialError)?) {
        Some(Item::Map(_)) => Ok(()),
        _ => Err(CredentialError),
    }
}

fn state(data: &[u8], flags: u8) -> AuthenticatorState {
    AuthenticatorState {
        sign_count: i64::from(u32::from_be_bytes([data[33], data[34], data[35], data[36]])),
        backup_eligible: flags & FLAG_BE != 0,
        backup_state: flags & FLAG_BS != 0,
    }
}

fn registered_key(
    data: &[u8],
    raw_id: &[u8],
    rp_id: &str,
) -> Result<(Vec<u8>, StoredKey, AuthenticatorState), CredentialError> {
    let flags = flags(data, rp_id)?;
    if flags & FLAG_AT == 0 || data.len() < CREDENTIAL_ID_START {
        return Err(CredentialError);
    }
    let length = usize::from(u16::from_be_bytes([data[53], data[54]]));
    let id = data
        .get(CREDENTIAL_ID_START..CREDENTIAL_ID_START + length)
        .ok_or(CredentialError)?;
    if !(1..=MAX_CREDENTIAL_ID_BYTES).contains(&length) || id != raw_id {
        return Err(CredentialError);
    }
    let start = CREDENTIAL_ID_START + length;
    let size = keys::template_length(&data[start..]).ok_or(CredentialError)?;
    let cose = data.get(start..start + size).ok_or(CredentialError)?;
    let key = keys::decode(cose).ok_or(CredentialError)?;
    extensions_to_end(data, start + size, flags)?;
    Ok((cose.to_vec(), key, state(data, flags)))
}

fn statement(
    fmt: Option<&Item>,
    statement: &Item,
    key: &StoredKey,
    signed: &[u8],
) -> Result<(), CredentialError> {
    if fmt == Some(&Item::Text("none".into())) && statement == &Item::Map(Vec::new()) {
        return Ok(());
    }
    let mut members = statement.text_keys().ok_or(CredentialError)?;
    members.sort_unstable();
    match (
        fmt,
        members.as_slice(),
        statement.get("alg"),
        statement.get("sig"),
    ) {
        (
            Some(Item::Text(format)),
            ["alg", "sig"],
            Some(Item::Int(algorithm)),
            Some(Item::Bytes(signature)),
        ) if format == "packed"
            && *algorithm == i128::from(key.algorithm())
            && key.verifies(signed, signature) =>
        {
            Ok(())
        }
        _ => Err(CredentialError),
    }
}

/// Verify one registration credential for `challenge` at `relying`.
///
/// # Errors
///
/// [`CredentialError`] for any refusal.
pub fn verify_registration(
    credential: &Value,
    challenge: &[u8],
    relying: &Relying<'_>,
) -> Result<Registration, CredentialError> {
    let (credential_id, raw_id, response) =
        shape(credential, &["attestationObject", "clientDataJSON"])?;
    let attestation_object = decode(response.get("attestationObject"), 65_536)?;
    let client_data_json = decode(response.get("clientDataJSON"), 16_384)?;
    client_data(
        &client_data_json,
        "webauthn.create",
        challenge,
        relying.origin,
    )?;
    let attestation = cbor::item(&attestation_object).ok_or(CredentialError)?;
    let mut members = attestation.text_keys().ok_or(CredentialError)?;
    members.sort_unstable();
    let (Some(Item::Bytes(data)), Some(statement_item @ Item::Map(_))) =
        (attestation.get("authData"), attestation.get("attStmt"))
    else {
        return Err(CredentialError);
    };
    if members != ["attStmt", "authData", "fmt"] {
        return Err(CredentialError);
    }
    let (cose, key, state) = registered_key(data, &raw_id, relying.rp_id)?;
    let signed = [
        data.as_slice(),
        digest::digest(&digest::SHA256, &client_data_json).as_ref(),
    ]
    .concat();
    statement(attestation.get("fmt"), statement_item, &key, &signed)?;
    Ok(Registration {
        credential_id,
        public_key: cose,
        state,
    })
}

/// Check an assertion's shape (W1, W2) and user handle (W8) for `relying`.
///
/// # Errors
///
/// [`CredentialError`] for any refusal.
pub fn parse_assertion(
    credential: &Value,
    relying: &Relying<'_>,
) -> Result<Assertion, CredentialError> {
    let members = [
        "authenticatorData",
        "clientDataJSON",
        "signature",
        "userHandle",
    ];
    let (credential_id, _raw, response) = shape(credential, &members)?;
    match response.get("userHandle") {
        Some(Value::Null) => {}
        handle => {
            let bytes = decode(handle, MAX_ID_CHARACTERS)?;
            if bytes != relying.user_handle {
                return Err(CredentialError);
            }
        }
    }
    Ok(Assertion {
        credential_id,
        authenticator_data: decode(response.get("authenticatorData"), 4096)?,
        client_data_json: decode(response.get("clientDataJSON"), 16_384)?,
        signature: decode(response.get("signature"), 4096)?,
    })
}

/// Verify an admitted assertion: client and authenticator data first, then the stored key, then the signature.
///
/// # Errors
///
/// `Err(Ok(CredentialError))` for the client's refusal, `Err(Err(StoredKeyInvalid))` for a stored key outside every
/// template.
pub fn verify_assertion(
    assertion: &Assertion,
    challenge: &[u8],
    stored_key: &[u8],
    relying: &Relying<'_>,
) -> Result<AuthenticatorState, Result<CredentialError, StoredKeyInvalid>> {
    client_data(
        &assertion.client_data_json,
        "webauthn.get",
        challenge,
        relying.origin,
    )
    .map_err(Ok)?;
    let data = &assertion.authenticator_data;
    let flags = flags(data, relying.rp_id).map_err(Ok)?;
    if flags & FLAG_AT != 0 {
        return Err(Ok(CredentialError));
    }
    extensions_to_end(data, AUTH_DATA_BYTES, flags).map_err(Ok)?;
    let key = keys::decode(stored_key).ok_or(Err(StoredKeyInvalid))?;
    let signed = [
        data.as_slice(),
        digest::digest(&digest::SHA256, &assertion.client_data_json).as_ref(),
    ]
    .concat();
    if !key.verifies(&signed, &assertion.signature) {
        return Err(Ok(CredentialError));
    }
    Ok(state(data, flags))
}
