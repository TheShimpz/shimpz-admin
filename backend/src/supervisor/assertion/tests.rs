use super::*;

fn request() -> RequestBinding {
    RequestBinding {
        method: "POST".to_owned(),
        path: "/v1/teams/marketing/chat".to_owned(),
        body: json_body(b"{}"),
        model: Some(model_binding("openai", "sk-test-0123456789abcdef")),
        assurance: None,
        decision: None,
    }
}

#[test]
fn an_assertion_is_canonical_short_lived_and_names_its_request() {
    let identity = LocalIdentity::generate();
    let token = sign_request(
        &identity,
        "cookie-value",
        AuthorityKind::Session,
        &request(),
        1_760_000_000,
    )
    .unwrap();
    let parts: Vec<&str> = token.split('.').collect();
    let header = BASE64URL_NOPAD.decode(parts[0].as_bytes()).unwrap();
    assert_eq!(
        header,
        b"{\"alg\":\"EdDSA\",\"kid\":\"local-supervisor-v1\",\"typ\":\"JWT\"}"
    );
    let claims = crate::json::parse(&BASE64URL_NOPAD.decode(parts[1].as_bytes()).unwrap()).unwrap();
    assert_eq!(
        crate::json::get(&claims, "exp"),
        Some(&crate::json::int(1_760_000_015))
    );
    assert_eq!(
        crate::json::get_str(&claims, "authority_sha256"),
        Some(sha256_hex(b"cookie-value").as_str())
    );
    assert!(!crate::json::compact(&claims).contains("sk-test"));
    let public = identity.public_key_raw();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &BASE64URL_NOPAD.decode(parts[2].as_bytes()).unwrap(),
        )
        .unwrap();
}

#[test]
fn a_routine_assertion_never_carries_a_model_or_assurance() {
    let identity = LocalIdentity::generate();
    assert!(sign_routine_request(&identity, "lease", &request(), 1_760_000_000).is_err());
    let mut plain = request();
    plain.model = None;
    let token = sign_routine_request(&identity, "lease", &plain, 1_760_000_000).unwrap();
    let claims = crate::json::parse(
        &BASE64URL_NOPAD
            .decode(token.split('.').nth(1).unwrap().as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(crate::json::get_str(&claims, "authority"), Some("routine"));
    assert_eq!(
        crate::json::get_str(&claims, "aud"),
        Some("team-local-routine")
    );
}
