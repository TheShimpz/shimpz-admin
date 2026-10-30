//! Fuzzes the session token's verification over arbitrary text: a forged or malformed token is never evidence.
#![no_main]

use admin_backend::signin::token;

const SECRET: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    assert!(token::signed_evidence(SECRET, &text).is_none() || text.starts_with("v3:"));
});
