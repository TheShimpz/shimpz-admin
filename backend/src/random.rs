//! Cryptographically random identifiers and secrets, as Python's `secrets` module draws them.

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};

/// `N` random bytes from the operating system.
///
/// # Panics
///
/// Panics when the operating system has no randomness to give, which Admin cannot run without.
#[must_use]
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut buffer = [0_u8; N];
    getrandom::fill(&mut buffer).expect("the operating system's randomness is unavailable");
    buffer
}

/// `secrets.token_hex(count)`: `count` random bytes as lowercase hex.
///
/// # Panics
///
/// Panics when the operating system has no randomness to give.
#[must_use]
pub fn hex(count: usize) -> String {
    let mut buffer = vec![0_u8; count];
    getrandom::fill(&mut buffer).expect("the operating system's randomness is unavailable");
    HEXLOWER.encode(&buffer)
}

/// `secrets.token_urlsafe(count)`: `count` random bytes as unpadded URL-safe base64.
///
/// # Panics
///
/// Panics when the operating system has no randomness to give.
#[must_use]
pub fn urlsafe(count: usize) -> String {
    let mut buffer = vec![0_u8; count];
    getrandom::fill(&mut buffer).expect("the operating system's randomness is unavailable");
    BASE64URL_NOPAD.encode(&buffer)
}

/// `secrets.randbelow(bound)`: a uniform integer in `0..bound` (`bound` > 0).
#[must_use]
pub fn below(bound: u64) -> u64 {
    let bound = bound.max(1);
    let zone = u64::MAX - u64::MAX % bound;
    loop {
        let value = u64::from_le_bytes(bytes::<8>());
        if value < zone {
            return value % bound;
        }
    }
}
