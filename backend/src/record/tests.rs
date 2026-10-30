use std::sync::Arc;

use super::*;
use crate::signin::password;

fn store(root: &Path) -> Store {
    let clock = Arc::new(Clock::new());
    let sessions = Arc::new(Sessions::new(Arc::clone(&clock)));
    Store::new(
        root.join("admin.json"),
        clock,
        sessions,
        Arc::new(Topics::new()),
    )
}

#[test]
fn a_fresh_store_is_uninitialized_and_setup_begins_enrollment() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    assert_eq!(
        store.classified_authentication_state(),
        Ok(AuthState::Uninitialized)
    );
    let verifier = password::new_password_verifier("correct horse battery staple x").unwrap();
    let enrollment = store.begin_supervisor_setup(&verifier).unwrap();
    assert!(
        enrollment
            .uri
            .starts_with("otpauth://totp/Shimpz%20Supervisor?secret=")
    );
    assert_eq!(
        store.authentication_state(),
        Ok(AuthState::EnrollmentRequired)
    );
    assert_eq!(
        store.begin_supervisor_setup(&verifier),
        Err(StateError::AlreadyConfigured)
    );
    let text = std::fs::read_to_string(root.path().join("admin.json")).unwrap();
    assert!(text.starts_with("{\n  \"auth_version\": 1,\n"));
}

#[test]
fn an_unrecognized_record_needs_recovery_and_a_corrupt_one_fails_loud() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    crate::fsio::replace_atomically(
        &root.path().join("admin.json"),
        b"{\"model_credentials\": {}}",
    )
    .unwrap();
    assert_eq!(
        store.classified_authentication_state(),
        Ok(AuthState::RecoveryRequired)
    );
    crate::fsio::replace_atomically(&root.path().join("admin.json"), b"{\"a\": 1, \"a\": 2}")
        .unwrap();
    assert_eq!(store.get(), Err(StateError::Corrupt));
    crate::fsio::replace_atomically(&root.path().join("admin.json"), b"[]").unwrap();
    assert_eq!(store.get(), Err(StateError::Corrupt));
}

#[test]
fn a_journal_that_refuses_writes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let refused = store.mutate(
        |data| {
            json::set(data, "consumed_host_resets", json::Value::Array(Vec::new()));
            Ok(())
        },
        |()| true,
        Some(&|()| Err(StateError::Audit)),
    );
    assert_eq!(refused, Err(StateError::Audit));
    assert!(!root.path().join("admin.json").exists());
}

#[test]
fn a_host_reset_capability_is_consumed_once() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let digest = "a".repeat(64);
    let expires = store.clock.now_secs() + 60;
    assert_eq!(
        store.consume_host_reset_capability(&digest, expires),
        Ok(true)
    );
    assert_eq!(
        store.consume_host_reset_capability(&digest, expires),
        Ok(false)
    );
    assert_eq!(
        store.classified_authentication_state(),
        Ok(AuthState::Uninitialized)
    );
}
