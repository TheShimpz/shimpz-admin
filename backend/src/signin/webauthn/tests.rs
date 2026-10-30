use account_webauthn::{
    keys::{EDDSA, ES256},
    testing::{Authenticator, BE, BS, UP, UV},
};

use super::*;

const HANDLE: [u8; 32] = [3; 32];

fn challenge(origin: &str, rp_id: &str) -> Challenge {
    Challenge {
        challenge: [7; 32],
        origin: origin.to_owned(),
        rp_id: rp_id.to_owned(),
        generation: 1,
        expires_at_ms: 1,
    }
}

fn encoded_challenge() -> String {
    BASE64URL_NOPAD.encode(&[7; 32])
}

/// Registers a credential made at `made_at` for `ceremony`, then signs in with it there.
fn ceremony(ceremony: &Challenge, made_at: &str) -> Result<(Value, Authentication), PasskeyError> {
    let authenticator = Authenticator::new(ES256, b"supervisor", &ceremony.rp_id, made_at);
    let credential = authenticator.register(&encoded_challenge(), UP | UV | BE, false, None, b"");
    let record = verify_registration(ceremony, &credential, &HANDLE, 100)?;
    let assertion =
        authenticator.assertion(&encoded_challenge(), 4, UP | UV | BE | BS, Some(&HANDLE));
    let authenticated = verify_authentication(ceremony, &assertion, &record, &HANDLE)?;
    Ok((record, authenticated))
}

#[test]
fn the_loopback_page_registers_and_signs_in_at_localhost() {
    let loopback = challenge("http://localhost:7777", "localhost");
    let (record, authenticated) = ceremony(&loopback, "http://localhost:7777").unwrap();
    assert_eq!(json::get_str(&record, "rp_id"), Some("localhost"));
    assert_eq!(
        json::get_str(&record, "origin"),
        Some("http://localhost:7777")
    );
    assert_eq!(json::get_str(&record, "status"), Some("active"));
    assert_eq!(record.get("backup_eligible"), Some(&Value::Bool(true)));
    assert_eq!(record.get("backup_state"), Some(&Value::Bool(false)));
    assert_eq!(record.get("created_at"), Some(&json::int(100)));
    assert_eq!(
        json::get_str(&record, "credential_id"),
        Some("c3VwZXJ2aXNvcg")
    );
    assert_eq!(
        authenticated,
        Authentication {
            credential_id: "c3VwZXJ2aXNvcg".to_owned(),
            new_sign_count: 4,
            backup_eligible: true,
            backup_state: true,
        }
    );
}

#[test]
fn an_external_https_origin_registers_and_signs_in_at_its_own_host() {
    let external = challenge("https://admin.example.org", "admin.example.org");
    assert!(ceremony(&external, "https://admin.example.org").is_ok());
    let authenticator = Authenticator::new(
        EDDSA,
        b"edwards",
        "admin.example.org",
        "https://admin.example.org",
    );
    let credential = authenticator.register(&encoded_challenge(), UP | UV, false, None, b"");
    assert!(verify_registration(&external, &credential, &HANDLE, 1).is_ok());
}

#[test]
fn another_origin_sharing_the_rp_is_refused() {
    let external = challenge("https://admin.example.org", "admin.example.org");
    assert_eq!(
        ceremony(&external, "https://admin.example.org:8443").unwrap_err(),
        INVALID_REGISTRATION
    );
    let loopback = challenge("http://localhost:7777", "localhost");
    assert_eq!(
        ceremony(&loopback, "http://localhost:8080").unwrap_err(),
        INVALID_REGISTRATION
    );
}

#[test]
fn an_assertion_for_another_user_or_with_a_damaged_stored_key_is_refused() {
    let loopback = challenge("http://localhost:7777", "localhost");
    let (record, _) = ceremony(&loopback, "http://localhost:7777").unwrap();
    let authenticator =
        Authenticator::new(ES256, b"supervisor", "localhost", "http://localhost:7777");
    let foreign = authenticator.assertion(&encoded_challenge(), 5, UP | UV, Some(&[4; 32]));
    assert_eq!(
        verify_authentication(&loopback, &foreign, &record, &HANDLE),
        Err(INVALID_AUTHENTICATION)
    );
    let mut damaged = record;
    json::set(&mut damaged, "public_key", json::text("AA"));
    let assertion = authenticator.assertion(&encoded_challenge(), 5, UP | UV, None);
    assert_eq!(
        verify_authentication(&loopback, &assertion, &damaged, &HANDLE),
        Err(STORED_INVALID)
    );
    let credential = json::object(vec![("id", json::text("AAAA"))]);
    assert_eq!(credential_id(&credential).as_deref(), Ok("AAAA"));
    assert!(credential_id(&json::object(vec![("id", json::text("a b"))])).is_err());
}
