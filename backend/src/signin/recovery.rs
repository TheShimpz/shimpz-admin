//! Single-use Supervisor recovery codes (ADR-0051): generated with each TOTP enrollment, stored only as scrypt digests.
//!
//! A set is ten random codes of twelve characters from a 32-letter alphabet (60 bits each), shown once. The set shares
//! one salt, so checking a candidate costs one derivation compared in constant time against every unused digest. A
//! code admits only the re-enrollment of TOTP; it never issues a session by itself.

use data_encoding::HEXLOWER;
use subtle::ConstantTimeEq;

use super::password::scrypt32;
use crate::json::{self, Value};

/// Codes in a set.
pub const CODE_COUNT: usize = 10;
/// Characters in a code.
pub const CODE_CHARS: usize = 12;
/// Characters per displayed group.
pub const GROUP_CHARS: usize = 4;
/// Crockford's base32 in lower case: no i, l, o, or u.
pub const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// The longest typed candidate.
pub const MAX_INPUT_CHARS: usize = 64;

/// Stored recovery codes are not the exact current contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecoveryStateError;

/// A fresh set: the codes to show once, and the record that keeps only their digests.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeSet {
    /// The codes as displayed (`xxxx-xxxx-xxxx`).
    pub codes: Vec<String>,
    /// The stored record.
    pub record: Value,
}

fn digest(normalized: &str, salt: &[u8]) -> String {
    HEXLOWER.encode(scrypt32(normalized.as_bytes(), salt, 14, 8, 1).as_slice())
}

fn display(code: &str) -> String {
    code.as_bytes()
        .chunks(GROUP_CHARS)
        .map(|group| String::from_utf8_lossy(group).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

fn random_code() -> String {
    (0..CODE_CHARS)
        .map(|_| {
            let index = usize::try_from(crate::random::below(32)).unwrap_or(0);
            char::from(ALPHABET[index])
        })
        .collect()
}

/// Ten fresh codes and their digests: ten scrypt derivations, so run it off the event loop.
#[must_use]
pub fn new_set() -> CodeSet {
    let salt = crate::random::bytes::<32>();
    let codes: Vec<String> = (0..CODE_COUNT).map(|_| random_code()).collect();
    let record = json::object(vec![
        ("salt", json::text(HEXLOWER.encode(&salt))),
        (
            "codes",
            Value::Array(
                codes
                    .iter()
                    .map(|code| {
                        json::object(vec![
                            ("digest", json::text(digest(code, &salt))),
                            ("used_at", Value::Null),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    CodeSet {
        codes: codes.iter().map(|code| display(code)).collect(),
        record,
    }
}

/// The comparison form of a typed code: case, spaces, and hyphens ignored; anything else is no code.
#[must_use]
pub fn normalized(candidate: &Value) -> Option<String> {
    let candidate = json::as_str(candidate)?;
    if team_protocol::python::text::len(candidate) > MAX_INPUT_CHARS {
        return None;
    }
    let value: String = team_protocol::python::text::lower(candidate)
        .chars()
        .filter(|character| *character != ' ' && *character != '-')
        .collect();
    (value.len() == CODE_CHARS && value.bytes().all(|byte| ALPHABET.contains(&byte)))
        .then_some(value)
}

fn hex64(value: Option<&Value>) -> bool {
    value.and_then(json::as_str).is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Validates one stored set.
///
/// # Errors
///
/// Returns [`RecoveryStateError`] for any set outside the exact current contract.
pub fn validated(record: &Value) -> Result<(), RecoveryStateError> {
    if !json::has_exactly(record, &["salt", "codes"]) || !hex64(record.get("salt")) {
        return Err(RecoveryStateError);
    }
    let codes = json::get(record, "codes")
        .and_then(json::as_array)
        .filter(|codes| codes.len() == CODE_COUNT)
        .ok_or(RecoveryStateError)?;
    let mut digests: Vec<&str> = Vec::with_capacity(CODE_COUNT);
    for entry in codes {
        let used = entry.get("used_at");
        let used_ok = matches!(used, Some(Value::Null))
            || used.and_then(json::as_int).is_some_and(|at| at >= 1);
        if !json::has_exactly(entry, &["digest", "used_at"])
            || !hex64(entry.get("digest"))
            || !used_ok
        {
            return Err(RecoveryStateError);
        }
        digests.push(json::get_str(entry, "digest").unwrap_or_default());
    }
    digests.sort_unstable();
    digests.dedup();
    if digests.len() == CODE_COUNT {
        Ok(())
    } else {
        Err(RecoveryStateError)
    }
}

/// How many codes of a strict set are still unused.
///
/// # Errors
///
/// Returns [`RecoveryStateError`] for an invalid set.
pub fn remaining(record: &Value) -> Result<usize, RecoveryStateError> {
    validated(record)?;
    Ok(json::get(record, "codes")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter(|entry| matches!(entry.get("used_at"), Some(Value::Null)))
        .count())
}

/// A typed code derived under one set's salt, computed before the transaction that compares it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The salt it was derived under.
    pub salt: String,
    /// Its digest, or `None` for a malformed code, which is simply refused.
    pub digest: Option<String>,
}

/// Derives a typed code under the set's salt.
///
/// # Errors
///
/// Returns [`RecoveryStateError`] for an invalid set.
pub fn candidate(record: &Value, typed: &Value) -> Result<Candidate, RecoveryStateError> {
    validated(record)?;
    let salt = json::get_str(record, "salt").unwrap_or_default().to_owned();
    let salt_bytes = HEXLOWER
        .decode(salt.as_bytes())
        .map_err(|_| RecoveryStateError)?;
    let digest = normalized(typed).map(|value| digest(&value, &salt_bytes));
    Ok(Candidate { salt, digest })
}

/// Marks the unused code matching `derived` as used at `now`; every digest is compared.
///
/// # Errors
///
/// Returns [`RecoveryStateError`] for an invalid set.
pub fn spend(
    record: &mut Value,
    derived: &Candidate,
    now: i64,
) -> Result<bool, RecoveryStateError> {
    validated(record)?;
    let presented = derived.digest.clone().unwrap_or_default();
    let mut matched = None;
    if let Some(Value::Array(codes)) = json::get(record, "codes") {
        for (index, entry) in codes.iter().enumerate() {
            let stored = json::get_str(entry, "digest").unwrap_or_default();
            let equal = bool::from(stored.as_bytes().ct_eq(presented.as_bytes()));
            if equal && matches!(entry.get("used_at"), Some(Value::Null)) {
                matched = Some(index);
            }
        }
    }
    let Some(index) = matched else {
        return Ok(false);
    };
    if let Value::Object(members) = record
        && let Some((_, Value::Array(codes))) = members.iter_mut().find(|(name, _)| name == "codes")
        && let Some(entry) = codes.get_mut(index)
    {
        json::set(entry, "used_at", json::int(now));
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
