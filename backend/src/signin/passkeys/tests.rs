use std::sync::Arc;

use super::*;

#[test]
fn a_passkey_rp_is_the_exact_host_of_localhost_or_an_https_domain() {
    assert_eq!(
        rp_id_for_origin("http://localhost:7777").unwrap(),
        "localhost"
    );
    assert_eq!(
        rp_id_for_origin("https://admin.example.org").unwrap(),
        "admin.example.org"
    );
    assert_eq!(rp_id_for_origin("https://localhost").unwrap(), "localhost");
    for refused in [
        "http://127.0.0.1:7777",
        "https://10.0.0.1",
        "http://admin.example.org",
        "https://intranet",
        "https://Admin.example.org",
        "https://admin.example.org/",
    ] {
        assert!(rp_id_for_origin(refused).is_err(), "{refused}");
    }
}

#[test]
fn options_are_py_webauthn_s_documents_for_user_verified_passkeys() {
    let challenges = Challenges::new(Arc::new(Clock::new()));
    let binding = "b".repeat(32);
    let challenge = challenges
        .issue(&binding, Ceremony::Registration, "http://localhost:7777", 1)
        .unwrap();
    let records = vec![json::object(vec![("credential_id", json::text("AQID"))])];
    let options = registration_options(&challenge, &"ab".repeat(32), &records);
    let text = json::compact(&options);
    assert!(text.starts_with("{\"rp\":{\"name\":\"Shimpz\",\"id\":\"localhost\"},\"user\":{\"id\":\"q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s\""));
    assert!(text.ends_with(",\"timeout\":180000,\"excludeCredentials\":[{\"id\":\"AQID\",\"type\":\"public-key\"}],\"authenticatorSelection\":{\"residentKey\":\"preferred\",\"requireResidentKey\":false,\"userVerification\":\"required\"},\"attestation\":\"none\"}"));
    assert!(authentication_options(&challenge, &[]).is_err());
}

#[test]
fn a_challenge_is_taken_once_for_its_ceremony() {
    let clock = Arc::new(Clock::new());
    let challenges = Challenges::new(Arc::clone(&clock));
    let binding = "b".repeat(32);
    challenges
        .issue(
            &binding,
            Ceremony::Authentication,
            "http://localhost:7777",
            1,
        )
        .unwrap();
    assert!(
        challenges
            .consume(&binding, Ceremony::Registration)
            .is_err()
    );
    assert!(
        challenges
            .consume(&binding, Ceremony::Authentication)
            .is_ok()
    );
    assert!(
        challenges
            .consume(&binding, Ceremony::Authentication)
            .is_err()
    );
    challenges
        .issue(
            &binding,
            Ceremony::Authentication,
            "http://localhost:7777",
            1,
        )
        .unwrap();
    clock.advance(180);
    assert!(
        challenges
            .consume(&binding, Ceremony::Authentication)
            .is_err()
    );
    assert!(
        challenges
            .issue(
                "short",
                Ceremony::Authentication,
                "http://localhost:7777",
                1
            )
            .is_err()
    );
}
