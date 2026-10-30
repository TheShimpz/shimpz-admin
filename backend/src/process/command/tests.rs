use std::process::Command;

use super::*;

const CHILD: &str = "SHIMPZ_ADMIN_PANIC_CHILD";
const SENTINEL: &str = "PRIVATE_SENTINEL_5f1c0e";

#[test]
fn a_panic_reports_where_it_happened_and_never_its_payload() {
    if std::env::var_os(CHILD).is_some() {
        install_panic_hook();
        let secret = format!("{SENTINEL} in a request body");
        std::thread::spawn(move || panic!("{secret}"))
            .join()
            .unwrap_or(());
        std::panic::panic_any(SENTINEL.to_owned());
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "process::command::tests::a_panic_reports_where_it_happened_and_never_its_payload",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(!output.status.success());
    assert!(
        !stdout.contains(SENTINEL) && !stderr.contains(SENTINEL),
        "{stdout}{stderr}"
    );
    let reports: Vec<&str> = stderr
        .lines()
        .filter(|line| line.contains(r#""event":"panic""#))
        .collect();
    assert_eq!(reports.len(), 2, "{stderr}");
    assert!(
        reports
            .iter()
            .all(|line| line.contains(r#""location":"src/process/command/tests.rs:"#)),
        "{stderr}"
    );
}

#[test]
fn clearing_the_reset_capability_succeeds_when_it_is_already_absent() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("capability.json");
    std::fs::write(&target, "old").unwrap();
    assert!(clear_capability(&target).is_ok());
    assert!(!target.exists());
    assert!(
        clear_capability(&target).is_ok(),
        "an absent capability is already cleared"
    );
}
