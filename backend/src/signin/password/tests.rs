use super::*;
use crate::json;

const PASSWORD: &str = "correct horse battery staple x";

#[test]
fn a_verifier_is_python_s_scrypt_v1_over_the_raw_password() {
    let salt: Vec<u8> = (0..32).collect();
    let digest = scrypt32(PASSWORD.as_bytes(), &salt, LOG_N, R, P);
    assert_eq!(
        HEXLOWER.encode(digest.as_slice()),
        "56b2fd7e8533b66aad9f197741941f942f773fcb138a2e6b7a9411084556f1a3"
    );
    let record = json::object(vec![(
        "password_verifier",
        json::text(format!(
            "scrypt-v1$ln=14,r=8,p=5,dk=32${}${}",
            HEXLOWER.encode(&salt),
            HEXLOWER.encode(digest.as_slice())
        )),
    )]);
    assert_eq!(verify_password(PASSWORD, &record), Ok(true));
    assert_eq!(
        verify_password("correct horse battery staple y", &record),
        Ok(false)
    );
    assert_eq!(verify_password("", &record), Err(VerifyError::Input));
}

#[test]
fn only_the_exact_verifier_contract_is_a_password_record() {
    let verifier = new_password_verifier(PASSWORD).unwrap();
    assert_eq!(
        password_set(&json::object(vec![(
            "password_verifier",
            json::text(&verifier)
        )])),
        Ok(true)
    );
    assert_eq!(password_set(&json::empty()), Ok(false));
    for broken in [
        verifier.replace("p=5", "p=1"),
        format!("{verifier}\n"),
        verifier.to_uppercase(),
        "scrypt-v1$ln=14,r=8,p=5,dk=32$00$00".to_owned(),
    ] {
        let record = json::object(vec![("password_verifier", json::text(broken))]);
        assert_eq!(password_set(&record), Err(PasswordRecordError));
    }
}

#[test]
fn the_policy_refuses_short_common_repeated_and_guessable_passwords() {
    assert_eq!(
        normalized_password("  ＰａｓｓＷｏｒｄ\u{a0} ẞtraße  "),
        "password sstrasse"
    );
    assert_eq!(password_policy("short"), Some(PolicyViolation::TooShort));
    assert_eq!(
        password_policy(&"x".repeat(4097)),
        Some(PolicyViolation::TooLong)
    );
    assert_eq!(
        password_policy("aaaaaaaaaaaaaaaa"),
        Some(PolicyViolation::Blocklisted)
    );
    assert_eq!(
        password_policy("shimpzshimpzshimpzadmin1"),
        Some(PolicyViolation::Blocklisted)
    );
    assert_eq!(password_policy(PASSWORD), None);
    assert!(
        blocklist()
            .iter()
            .all(|entry| normalized_password(entry) == *entry && text::len(entry) >= 15)
    );
}

#[test]
fn the_limiter_allows_one_derivation_and_locks_after_five_rejections() {
    let clock = std::sync::Arc::new(Clock::new());
    let limiter = std::sync::Arc::new(LoginLimiter::new(std::sync::Arc::clone(&clock)));
    let permit = limiter.begin().unwrap();
    assert_eq!(limiter.begin().err(), Some(RateLimited { retry_after: 1 }));
    assert_eq!(permit.finish(Some(true)), 0);
    for _ in 0..3 {
        let _ = limiter.begin().unwrap().finish(Some(true));
    }
    assert_eq!(limiter.begin().unwrap().finish(Some(true)), 60);
    assert_eq!(limiter.begin().err(), Some(RateLimited { retry_after: 60 }));
    clock.advance(60);
    drop(limiter.begin().unwrap());
    assert!(limiter.begin().is_ok());
}
