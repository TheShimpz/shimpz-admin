//! The Local Supervisor password: its policy, its strict `scrypt-v1` verifier, and the login limiter.

use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
};

use data_encoding::HEXLOWER;
use subtle::ConstantTimeEq;
use team_protocol::python::text;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::{
    json::{self, Value},
    sync::lock,
    time::clock::Clock,
};

/// The fewest characters a new password has.
pub const MIN_PASSWORD_CHARS: usize = 15;
/// The most characters any password has.
pub const MAX_PASSWORD_CHARS: usize = 4 * 1024;
/// Words the Supervisor's own context makes guessable; a password keeps 15 characters without them.
pub const CONTEXT_WORDS: [&str; 3] = ["shimpz", "supervisor", "admin"];
/// Rejected logins before the limiter locks.
pub const LOGIN_FAILURE_LIMIT: u32 = 5;
/// How long the limiter locks.
pub const LOGIN_LOCK_MS: i64 = 60 * 1000;

const SCHEME: &str = "scrypt-v1";
const PARAMETERS: &str = "ln=14,r=8,p=5,dk=32";
const LOG_N: u8 = 14;
const R: u32 = 8;
const P: u32 = 5;

/// The common-password blocklist (`blocklist.txt`) in the policy's comparison form: every entry of the `SecLists` Pwdb top
/// one million list at commit 913b327 (sha256 e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8), its
/// `$hex[...]` entries decoded, kept when its comparison form is at least the minimum password length.
static BLOCKLIST: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| include_str!("../../../blocklist.txt").lines().collect());

/// Why a new password is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyViolation {
    /// Fewer than 15 characters, before or after normalization.
    TooShort,
    /// More than 4,096 characters.
    TooLong,
    /// Common, repeated, or guessable from Shimpz's own words.
    Blocklisted,
}

impl PolicyViolation {
    /// The violation's closed code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooShort => "password-too-short",
            Self::TooLong => "password-too-long",
            Self::Blocklisted => "password-blocklisted",
        }
    }

    /// The violation's detail as the setup page shows it.
    #[must_use]
    pub const fn detail(self) -> &'static str {
        match self {
            Self::TooShort => "password must be at least 15 characters",
            Self::TooLong => "password is too long",
            Self::Blocklisted => "choose a password that is not commonly used or expected",
        }
    }
}

/// The stored password record is not the exact current contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordRecordError;

/// Why a password could not be checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// The password itself is not a bounded string.
    Input,
    /// The stored record needs bounded recovery, or none is configured.
    Record,
}

/// The comparison form shared by the policy and the blocklist generator: NFKC, casefolded, whitespace collapsed.
#[must_use]
pub fn normalized_password(password: &str) -> String {
    let folded = text::casefold(&password.nfkc().collect::<String>());
    folded
        .split(text::isspace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn repeated_unit(value: &str) -> bool {
    let characters: Vec<char> = value.chars().collect();
    if characters.len() <= 1 {
        return false;
    }
    let doubled: Vec<char> = characters
        .iter()
        .chain(characters.iter())
        .copied()
        .collect();
    let inner = &doubled[1..doubled.len() - 1];
    inner
        .windows(characters.len())
        .any(|window| window == characters.as_slice())
}

fn without_context(normalized: &str) -> String {
    let mut remainder = normalized.to_owned();
    for word in CONTEXT_WORDS {
        remainder = remainder.replace(word, "");
    }
    remainder
        .split(text::isspace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether the blocklist holds `entry` (one line in comparison form).
#[must_use]
pub fn blocklisted(entry: &str) -> bool {
    BLOCKLIST.contains(entry)
}

/// The blocklist's entries.
#[must_use]
pub fn blocklist() -> &'static HashSet<&'static str> {
    &BLOCKLIST
}

/// The exact policy violation of a new password, or `None` when it is admitted.
#[must_use]
pub fn password_policy(password: &str) -> Option<PolicyViolation> {
    let length = text::len(password);
    if length < MIN_PASSWORD_CHARS {
        return Some(PolicyViolation::TooShort);
    }
    if length > MAX_PASSWORD_CHARS {
        return Some(PolicyViolation::TooLong);
    }
    let normalized = normalized_password(password);
    if text::len(&normalized) < MIN_PASSWORD_CHARS {
        return Some(PolicyViolation::TooShort);
    }
    let remainder = without_context(&normalized);
    if [&normalized, &remainder]
        .iter()
        .any(|value| blocklisted(value) || repeated_unit(value))
        || text::len(&remainder) < MIN_PASSWORD_CHARS
    {
        return Some(PolicyViolation::Blocklisted);
    }
    None
}

/// scrypt with `log2 N`, `r`, and `p` over `secret` and `salt`, 32 bytes long.
#[must_use]
pub fn scrypt32(secret: &[u8], salt: &[u8], log_n: u8, r: u32, p: u32) -> Zeroizing<[u8; 32]> {
    let mut output = Zeroizing::new([0_u8; 32]);
    let params = scrypt::Params::new(log_n, r, p)
        .unwrap_or_else(|_| unreachable!("fixed scrypt parameters"));
    if scrypt::scrypt(secret, salt, &params, output.as_mut_slice()).is_err() {
        unreachable!("a 32-byte scrypt output");
    }
    output
}

/// A strict current-contract verifier for an admitted new password.
///
/// # Errors
///
/// Returns the password's [`PolicyViolation`].
pub fn new_password_verifier(password: &str) -> Result<String, PolicyViolation> {
    if let Some(violation) = password_policy(password) {
        return Err(violation);
    }
    let salt = crate::random::bytes::<32>();
    let digest = scrypt32(password.as_bytes(), &salt, LOG_N, R, P);
    Ok(format!(
        "{SCHEME}${PARAMETERS}${}${}",
        HEXLOWER.encode(&salt),
        HEXLOWER.encode(digest.as_slice())
    ))
}

fn hex64(text: &str) -> Option<Vec<u8>> {
    (text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then(|| HEXLOWER.decode(text.as_bytes()).ok())
    .flatten()
}

/// A verifier's salt and digest.
pub type Material = (Vec<u8>, Vec<u8>);

/// The verifier's salt and digest; `Ok(None)` when no password is set.
///
/// # Errors
///
/// Returns [`PasswordRecordError`] for a record or verifier outside the exact current contract.
pub fn password_material(record: &Value) -> Result<Option<Material>, PasswordRecordError> {
    if json::members(record).is_none() {
        return Err(PasswordRecordError);
    }
    let verifier = match json::get(record, "password_verifier") {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => json::as_str(value).ok_or(PasswordRecordError)?,
    };
    let rest = verifier
        .strip_prefix(&format!("{SCHEME}${PARAMETERS}$"))
        .ok_or(PasswordRecordError)?;
    let (salt, digest) = rest.split_once('$').ok_or(PasswordRecordError)?;
    match (hex64(salt), hex64(digest)) {
        (Some(salt), Some(digest)) => Ok(Some((salt, digest))),
        _ => Err(PasswordRecordError),
    }
}

/// Whether a strict password verifier exists (`configured`) or not (`uninitialized`).
///
/// # Errors
///
/// Returns [`PasswordRecordError`] for an invalid record.
pub fn password_set(record: &Value) -> Result<bool, PasswordRecordError> {
    password_material(record).map(|material| material.is_some())
}

/// Verifies one bounded password against only the exact current record contract (an scrypt derivation: run it off
/// the event loop).
///
/// # Errors
///
/// Returns [`VerifyError`].
pub fn verify_password(password: &str, record: &Value) -> Result<bool, VerifyError> {
    let length = text::len(password);
    if !(1..=MAX_PASSWORD_CHARS).contains(&length) {
        return Err(VerifyError::Input);
    }
    let (salt, expected) = password_material(record)
        .map_err(|_| VerifyError::Record)?
        .ok_or(VerifyError::Record)?;
    let derived = scrypt32(password.as_bytes(), &salt, LOG_N, R, P);
    Ok(bool::from(derived.as_slice().ct_eq(&expected)))
}

/// A login could not reserve its one password derivation: retry after this many seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimited {
    /// Seconds to wait.
    pub retry_after: u64,
}

#[derive(Default)]
struct LimiterState {
    in_flight: bool,
    failures: u32,
    locked_until_ms: i64,
}

/// Bounds the singleton Local login before any expensive password work begins: one derivation at a time, and a lock
/// after repeated rejections.
pub struct LoginLimiter {
    clock: std::sync::Arc<Clock>,
    state: Mutex<LimiterState>,
}

/// One reserved password derivation; finishing it reports its outcome, and dropping it unfinished releases it.
pub struct Permit {
    limiter: std::sync::Arc<LoginLimiter>,
    finished: bool,
}

impl LoginLimiter {
    /// No login yet.
    #[must_use]
    pub fn new(clock: std::sync::Arc<Clock>) -> Self {
        Self {
            clock,
            state: Mutex::new(LimiterState::default()),
        }
    }

    /// Reserves the only derivation slot, or refuses at once without queueing.
    ///
    /// # Errors
    ///
    /// Returns [`RateLimited`] while locked or while another derivation runs.
    pub fn begin(self: &std::sync::Arc<Self>) -> Result<Permit, RateLimited> {
        let mut state = lock(&self.state);
        let now = self.clock.monotonic_ms();
        if state.locked_until_ms > now {
            let remaining = state.locked_until_ms - now;
            return Err(RateLimited {
                retry_after: u64::try_from((remaining + 999) / 1000).unwrap_or(1).max(1),
            });
        }
        if state.locked_until_ms != 0 {
            state.failures = 0;
            state.locked_until_ms = 0;
        }
        if state.in_flight {
            return Err(RateLimited { retry_after: 1 });
        }
        state.in_flight = true;
        drop(state);
        Ok(Permit {
            limiter: std::sync::Arc::clone(self),
            finished: false,
        })
    }

    fn finish(&self, rejected: Option<bool>) -> u64 {
        let mut state = lock(&self.state);
        state.in_flight = false;
        match rejected {
            None => 0,
            Some(false) => {
                state.failures = 0;
                state.locked_until_ms = 0;
                0
            }
            Some(true) => {
                state.failures += 1;
                if state.failures < LOGIN_FAILURE_LIMIT {
                    return 0;
                }
                state.locked_until_ms = self.clock.monotonic_ms() + LOGIN_LOCK_MS;
                u64::try_from(LOGIN_LOCK_MS / 1000).unwrap_or(60)
            }
        }
    }
}

impl Permit {
    /// Releases the slot with the derivation's outcome (`None` when it failed); returns a lock that begins now.
    #[must_use]
    pub fn finish(mut self, rejected: Option<bool>) -> u64 {
        self.finished = true;
        self.limiter.finish(rejected)
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if !self.finished {
            self.limiter.finish(None);
        }
    }
}

#[cfg(test)]
mod tests;
