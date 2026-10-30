use std::{os::unix::fs::PermissionsExt, sync::Arc};

use super::*;

fn audit(root: &Path) -> Audit {
    Audit::new(
        root.join("audit.jsonl"),
        Arc::new(Topics::new()),
        Arc::new(crate::clock::Clock::new()),
    )
}

#[test]
fn a_line_holds_only_the_time_event_outcome_origin_and_method() {
    let root = tempfile::tempdir().unwrap();
    let journal = audit(root.path());
    journal
        .record(
            "login",
            Outcome::Ok,
            Some("http://127.0.0.1:7777"),
            Some("totp"),
        )
        .unwrap();
    journal
        .record("password-rejected", Outcome::Denied, None, None)
        .unwrap();
    let text = std::fs::read_to_string(root.path().join("audit.jsonl")).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].starts_with("{\"event\":\"login\",\"method\":\"totp\",\"origin\":\"http://127.0.0.1:7777\",\"outcome\":\"ok\",\"ts\":\""));
    assert!(lines[1].starts_with(
        "{\"event\":\"password-rejected\",\"origin\":null,\"outcome\":\"denied\",\"ts\":\""
    ));
    let mode = std::fs::metadata(root.path().join("audit.jsonl"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_failed_write_refuses_every_later_change_until_restart() {
    let root = tempfile::tempdir().unwrap();
    let journal = audit(root.path());
    std::fs::write(root.path().join("audit.jsonl"), "").unwrap();
    std::fs::set_permissions(
        root.path().join("audit.jsonl"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(
        journal.record("login", Outcome::Ok, None, None),
        Err(AuditUnavailable)
    );
    std::fs::set_permissions(
        root.path().join("audit.jsonl"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        journal.record("login", Outcome::Ok, None, None),
        Err(AuditUnavailable)
    );
}

#[test]
fn the_history_names_the_sign_in_before_this_one_and_the_refusals_since() {
    let root = tempfile::tempdir().unwrap();
    let journal = audit(root.path());
    journal
        .record(
            "setup-completed",
            Outcome::Ok,
            Some("https://admin.example.org"),
            Some("totp"),
        )
        .unwrap();
    journal
        .record("totp-rejected", Outcome::Denied, None, None)
        .unwrap();
    journal
        .record("password-locked", Outcome::Denied, None, None)
        .unwrap();
    journal
        .record("login", Outcome::Ok, None, Some("passkey"))
        .unwrap();
    let now = crate::clock::Clock::new().now_secs();
    let history = journal.sign_in_history(now + 1).unwrap();
    assert_eq!(history.failures_since, 2);
    assert_eq!(
        history.previous.unwrap().1.as_deref(),
        Some("https://admin.example.org")
    );
    assert_eq!(
        journal.sign_in_history(0).unwrap(),
        SignInHistory {
            previous: None,
            failures_since: 0
        }
    );
}

#[test]
fn a_full_journal_rotates_to_two_backups() {
    let root = tempfile::tempdir().unwrap();
    let journal = audit(root.path());
    let path = root.path().join("audit.jsonl");
    std::fs::write(&path, "x".repeat(usize::try_from(MAX_BYTES).unwrap())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    journal.record("logout", Outcome::Ok, None, None).unwrap();
    assert!(root.path().join("audit.jsonl.1").exists());
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("\"logout\"")
    );
}
