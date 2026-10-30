use super::*;

fn challenge() -> Challenge {
    Challenge {
        challenge: [7; 32],
        origin: "http://localhost:7777".to_owned(),
        rp_id: "localhost".to_owned(),
        generation: 1,
        expires_at_ms: 1,
    }
}

#[test]
fn every_response_is_refused_until_the_verifier_is_mirrored() {
    let credential = json::object(vec![("id", json::text("AAAA"))]);
    assert_eq!(credential_id(&credential).as_deref(), Ok("AAAA"));
    assert!(credential_id(&json::text("AAAA")).is_err());
    assert!(credential_id(&json::object(vec![("id", json::text("a b"))])).is_err());
    assert_eq!(
        verify_authentication(&challenge(), &credential, &json::empty()),
        Err(PasskeyError::Unavailable("invalid passkey authentication"))
    );
    assert_eq!(
        verify_registration(&challenge(), &credential, 1),
        Err(PasskeyError::Unavailable("invalid passkey registration"))
    );
}
