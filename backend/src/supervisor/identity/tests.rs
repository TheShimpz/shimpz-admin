use super::*;

fn fixed() -> LocalIdentity {
    let seed = data_encoding::HEXLOWER.encode(&(0_u8..32).collect::<Vec<_>>());
    let record = crate::json::object(vec![
        ("supervisor_id", crate::json::text("0".repeat(32))),
        ("supervisor_signing_key", crate::json::text(seed)),
    ]);
    LocalIdentity::supervisor(&record).unwrap()
}

#[test]
fn the_published_key_and_signatures_are_those_python_wrote() {
    let identity = fixed();
    assert_eq!(
        String::from_utf8(identity.public_pem()).unwrap(),
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=\n-----END PUBLIC KEY-----\n"
    );
    assert_eq!(
        HEXLOWER.encode(&identity.sign(b"abc")),
        "cc46d62d3754f41754b27b6ea2cb2c272bafa7a5a1f6062bd060f414e50caaeac2da66ad39cef4424a90236ea907b7d8057e3443dc5abfc9986967ee7213a407"
    );
}

#[test]
fn only_exact_lowercase_hex_is_an_identity() {
    for (id, key) in [
        ("A".repeat(32), "0".repeat(64)),
        ("0".repeat(31), "0".repeat(64)),
        ("0".repeat(32), "0".repeat(63)),
    ] {
        let record = crate::json::object(vec![
            ("supervisor_id", crate::json::text(id)),
            ("supervisor_signing_key", crate::json::text(key)),
        ]);
        assert!(LocalIdentity::supervisor(&record).is_err());
    }
}

#[test]
fn a_key_is_published_only_into_a_safe_group_directory() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("keys");
    std::fs::create_dir(&directory).unwrap();
    let group = crate::fsio::egid();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(materialize(&directory.join("public.pem"), group, &fixed()).is_err());
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o2770)).unwrap();
    materialize(&directory.join("public.pem"), group, &fixed()).unwrap();
    let metadata = std::fs::metadata(directory.join("public.pem")).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o7777, 0o440);
    materialize(&directory.join("public.pem"), group, &fixed()).unwrap();
}
