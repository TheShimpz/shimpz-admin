use strict_json::Value;

use crate::{
    cbor::Item,
    encoding::base64url,
    keys::{self, EDDSA, ES256, RS256},
    testing::{Authenticator, BE, BS, ED, UP, UV, encode},
    verify::{self, CredentialError, Relying, StoredKeyInvalid},
};

const CHALLENGE: [u8; 32] = [5; 32];
/// Account's relying party, unchanged: the shimpz.com RP, the Developers origin, and a 16-byte Account id.
const RP_ID: &str = "shimpz.com";
const ORIGIN: &str = "https://developers.shimpz.com";
const ACCOUNT: [u8; 16] = [
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
];
const ACCOUNT_PARTY: Relying<'static> = Relying {
    rp_id: RP_ID,
    origin: ORIGIN,
    user_handle: &ACCOUNT,
};

fn emulated(algorithm: i64, raw_id: &[u8]) -> Authenticator {
    Authenticator::new(algorithm, raw_id, RP_ID, ORIGIN)
}

fn challenge() -> String {
    base64url(&CHALLENGE, false)
}

fn with_response(credential: &Value, member: &str, value: &Value) -> Value {
    let Value::Object(mut members) = credential.clone() else {
        unreachable!()
    };
    for (name, entry) in &mut members {
        if name == "response"
            && let Value::Object(response) = entry
        {
            response.retain(|(key, _)| key != member);
            response.push((member.into(), value.clone()));
        }
    }
    Value::Object(members)
}

fn with_member(credential: &Value, member: &str, value: Option<Value>) -> Value {
    let Value::Object(mut members) = credential.clone() else {
        unreachable!()
    };
    members.retain(|(name, _)| name != member);
    if let Some(value) = value {
        members.push((member.into(), value));
    }
    Value::Object(members)
}

#[test]
fn every_algorithm_registers_with_none_or_a_packed_self_attestation_and_authenticates() {
    for algorithm in [ES256, EDDSA, RS256] {
        let authenticator = emulated(algorithm, b"emulated");
        for packed in [false, true] {
            let registered = verify::verify_registration(
                &authenticator.register(&challenge(), UP | UV | BE | BS, packed, None, b""),
                &CHALLENGE,
                &ACCOUNT_PARTY,
            )
            .unwrap();
            assert_eq!(registered.public_key, authenticator.cose());
            assert_eq!(registered.credential_id, authenticator.credential_id());
            assert!(registered.state.backup_eligible && registered.state.backup_state);
        }
        let handle = ACCOUNT.to_vec();
        for user_handle in [None, Some(handle.as_slice())] {
            let assertion = authenticator.assertion(&challenge(), 9, UP | UV, user_handle);
            let parsed = verify::parse_assertion(&assertion, &ACCOUNT_PARTY).unwrap();
            assert_eq!(
                verify::verify_assertion(
                    &parsed,
                    &CHALLENGE,
                    &authenticator.cose(),
                    &ACCOUNT_PARTY
                )
                .unwrap()
                .sign_count,
                9
            );
        }
    }
}

#[test]
fn the_credential_must_have_developers_closed_shape() {
    let valid = emulated(ES256, b"emulated").register(&challenge(), UP | UV, false, None, b"");
    let other = Value::String(base64url(b"other", false));
    for credential in [
        with_member(&valid, "clientExtensionResults", None),
        with_member(&valid, "extra", Some(Value::Null)),
        with_member(
            &valid,
            "authenticatorAttachment",
            Some(Value::String("usb".into())),
        ),
        with_member(
            &valid,
            "clientExtensionResults",
            Some(Value::Object(vec![("credProps".into(), Value::Null)])),
        ),
        with_member(&valid, "rawId", Some(other.clone())),
        with_member(
            &with_member(&valid, "rawId", Some(other.clone())),
            "id",
            Some(other),
        ),
        with_member(&valid, "type", Some(Value::String("public_key".into()))),
        with_response(&valid, "extra", &Value::String("AA".into())),
        with_response(&valid, "clientDataJSON", &Value::String("+AAA".into())),
        with_response(
            &valid,
            "attestationObject",
            &Value::String("A".repeat(65_537)),
        ),
        Value::String("credential".into()),
    ] {
        assert_eq!(
            verify::verify_registration(&credential, &CHALLENGE, &ACCOUNT_PARTY),
            Err(CredentialError)
        );
    }
}

#[test]
fn client_data_members_beyond_the_closed_ones_are_ignored() {
    let authenticator = emulated(ES256, b"emulated");
    let origin = ORIGIN;
    for extra in [
        r#", "tokenBinding": {"id": "AA"}"#,
        r#", "topOrigin": "https://elsewhere.example""#,
    ] {
        let client = Authenticator::client_data("webauthn.create", &challenge(), origin, extra);
        assert!(
            verify::verify_registration(
                &authenticator.register(&challenge(), UP | UV, false, Some(client), b""),
                &CHALLENGE,
                &ACCOUNT_PARTY
            )
            .is_ok()
        );
    }
}

#[test]
fn client_data_must_name_this_ceremony_challenge_and_origin() {
    let authenticator = emulated(ES256, b"emulated");
    let origin = ORIGIN;
    for client in [
        Authenticator::client_data("webauthn.get", &challenge(), origin, ""),
        Authenticator::client_data("webauthn.create", &base64url(&[6; 32], false), origin, ""),
        Authenticator::client_data("webauthn.create", &challenge(), "https://shimpz.com", ""),
        String::from_utf8(Authenticator::client_data(
            "webauthn.create",
            &challenge(),
            origin,
            "",
        ))
        .unwrap()
        .replace("false", "true")
        .into_bytes(),
        String::from_utf8(Authenticator::client_data(
            "webauthn.create",
            &challenge(),
            origin,
            "",
        ))
        .unwrap()
        .replace("false", "0")
        .into_bytes(),
        [
            b"\xef\xbb\xbf".as_slice(),
            &Authenticator::client_data("webauthn.create", &challenge(), origin, ""),
        ]
        .concat(),
        Authenticator::client_data(
            "webauthn.create",
            &challenge(),
            origin,
            r#", "type": "webauthn.create""#,
        ),
    ] {
        let credential = authenticator.register(&challenge(), UP | UV, false, Some(client), b"");
        assert_eq!(
            verify::verify_registration(&credential, &CHALLENGE, &ACCOUNT_PARTY),
            Err(CredentialError)
        );
    }
}

#[test]
fn authenticator_data_must_prove_presence_verification_and_this_credential() {
    let authenticator = emulated(ES256, b"emulated");
    for flags in [UP, UV, UP | UV | BS] {
        let credential = authenticator.register(&challenge(), flags, false, None, b"");
        assert_eq!(
            verify::verify_registration(&credential, &CHALLENGE, &ACCOUNT_PARTY),
            Err(CredentialError)
        );
    }
    let extensions = encode(&Item::Map(vec![(
        Item::Text("credProtect".into()),
        Item::Int(1),
    )]));
    assert!(
        verify::verify_registration(
            &authenticator.register(&challenge(), UP | UV | ED, false, None, &extensions),
            &CHALLENGE,
            &ACCOUNT_PARTY
        )
        .is_ok()
    );
    for (flags, tail) in [
        (UP | UV | ED, Vec::new()),
        (UP | UV, extensions.clone()),
        (UP | UV | ED, [extensions, vec![0]].concat()),
    ] {
        let credential = authenticator.register(&challenge(), flags, false, None, &tail);
        assert_eq!(
            verify::verify_registration(&credential, &CHALLENGE, &ACCOUNT_PARTY),
            Err(CredentialError)
        );
    }
}

#[test]
fn only_the_three_templates_are_keys() {
    let es256 = emulated(ES256, b"k").cose();
    assert!(keys::decode(&es256).is_some());
    let mut off_curve = es256.clone();
    off_curve[76] ^= 1;
    assert!(keys::decode(&off_curve).is_none());
    let small_rsa = encode(&Item::Map(vec![
        (Item::Int(1), Item::Int(3)),
        (Item::Int(3), Item::Int(-257)),
        (
            Item::Int(-1),
            Item::Bytes([vec![0x80], vec![0; 126], vec![1]].concat()),
        ),
        (Item::Int(-2), Item::Bytes(vec![1, 0, 1])),
    ]));
    for cose in [
        small_rsa,
        es256[..76].to_vec(),
        [es256.as_slice(), &[0]].concat(),
        vec![0xa0],
    ] {
        assert!(keys::decode(&cose).is_none());
    }
}

#[test]
fn assertions_outside_the_rules_are_refused_and_a_bad_stored_key_is_server_state() {
    let authenticator = emulated(ES256, b"emulated");
    assert!(
        verify::parse_assertion(
            &authenticator.assertion(&challenge(), 1, UP | UV, Some(&[0; 16])),
            &ACCOUNT_PARTY
        )
        .is_err()
    );
    for flags in [UP | UV | 0x40, UP | UV | BS, UP | UV | ED] {
        let parsed = verify::parse_assertion(
            &authenticator.assertion(&challenge(), 1, flags, None),
            &ACCOUNT_PARTY,
        )
        .unwrap();
        assert_eq!(
            verify::verify_assertion(&parsed, &CHALLENGE, &authenticator.cose(), &ACCOUNT_PARTY),
            Err(Ok(CredentialError))
        );
    }
    let parsed = verify::parse_assertion(
        &authenticator.assertion(&challenge(), 1, UP | UV, None),
        &ACCOUNT_PARTY,
    )
    .unwrap();
    assert_eq!(
        verify::verify_assertion(&parsed, &CHALLENGE, &[0xa0], &ACCOUNT_PARTY),
        Err(Err(StoredKeyInvalid))
    );
    let other = emulated(ES256, b"emulated").cose();
    assert_eq!(
        verify::verify_assertion(&parsed, &CHALLENGE, &other, &ACCOUNT_PARTY),
        Err(Ok(CredentialError))
    );
}

/// The Local Admin's relying parties: the loopback page (`localhost`) and an external HTTPS origin, each with the
/// Admin's own 32-byte user handle.
const ADMIN_HANDLE: [u8; 32] = [9; 32];

fn ceremony(rp_id: &str, origin: &str, verifier_origin: &str) -> Result<(), CredentialError> {
    let party = Relying {
        rp_id,
        origin: verifier_origin,
        user_handle: &ADMIN_HANDLE,
    };
    let authenticator = Authenticator::new(ES256, b"supervisor", rp_id, origin);
    let registered = verify::verify_registration(
        &authenticator.register(&challenge(), UP | UV, false, None, b""),
        &CHALLENGE,
        &party,
    )?;
    let assertion = authenticator.assertion(&challenge(), 1, UP | UV, Some(&ADMIN_HANDLE));
    let parsed = verify::parse_assertion(&assertion, &party)?;
    verify::verify_assertion(&parsed, &CHALLENGE, &registered.public_key, &party)
        .map(|_| ())
        .map_err(|_| CredentialError)
}

#[test]
fn a_loopback_and_an_https_relying_party_each_admit_only_their_own_origin() {
    assert_eq!(
        ceremony(
            "localhost",
            "http://localhost:7777",
            "http://localhost:7777"
        ),
        Ok(())
    );
    assert_eq!(
        ceremony(
            "admin.example.org",
            "https://admin.example.org",
            "https://admin.example.org"
        ),
        Ok(())
    );
    // Another origin sharing the RP ID is refused: the ceremony's origin is exact, not its RP.
    assert_eq!(
        ceremony(
            "example.org",
            "https://other.example.org",
            "https://admin.example.org"
        ),
        Err(CredentialError)
    );
    assert_eq!(
        ceremony(
            "localhost",
            "http://localhost:7777",
            "http://127.0.0.1:7777"
        ),
        Err(CredentialError)
    );
}

#[test]
fn an_assertion_names_no_user_handle_or_exactly_the_relying_partys() {
    let party = Relying {
        rp_id: "localhost",
        origin: "http://localhost:7777",
        user_handle: &ADMIN_HANDLE,
    };
    let authenticator =
        Authenticator::new(ES256, b"supervisor", "localhost", "http://localhost:7777");
    for handle in [None, Some(&ADMIN_HANDLE[..])] {
        assert!(
            verify::parse_assertion(
                &authenticator.assertion(&challenge(), 1, UP | UV, handle),
                &party
            )
            .is_ok()
        );
    }
    for handle in [&ACCOUNT[..], &ADMIN_HANDLE[..31]] {
        assert_eq!(
            verify::parse_assertion(
                &authenticator.assertion(&challenge(), 1, UP | UV, Some(handle)),
                &party
            ),
            Err(CredentialError)
        );
    }
}
