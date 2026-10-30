use super::*;

fn written(root: &Path, document: &str) -> std::path::PathBuf {
    let path = root.join("status.json");
    fsio::replace_atomically(&path, document.as_bytes()).unwrap();
    path
}

#[test]
fn only_the_closed_projection_is_shown_with_its_utc_check_time() {
    let root = tempfile::tempdir().unwrap();
    let release = format!(
        "ghcr.io/theshimpz/shimpz-local-release@sha256:{}",
        "a".repeat(64)
    );
    let path = written(
        root.path(),
        &format!(
            "{{\"release\":\"{release}\",\"ordinal\":3,\"checked_at\":1760000000,\"outcome\":\"current\"}}"
        ),
    );
    let reply = status_response(&path).unwrap();
    assert_eq!(reply.get_str("checked_at"), Some("2025-10-09T08:53:20Z"));
    assert_eq!(reply.get_str("release"), Some(release.as_str()));
    for refused in [
        "{}".to_owned(),
        format!(
            "{{\"release\":\"{release}\",\"ordinal\":0,\"checked_at\":1,\"outcome\":\"current\"}}"
        ),
        format!(
            "{{\"release\":\"{release}\",\"ordinal\":true,\"checked_at\":1,\"outcome\":\"current\"}}"
        ),
        format!(
            "{{\"release\":\"{release}\",\"ordinal\":1,\"checked_at\":1,\"outcome\":\"other\"}}"
        ),
        "{\"release\":\"x\",\"ordinal\":1,\"checked_at\":1,\"outcome\":\"current\"}".to_owned(),
    ] {
        let path = written(root.path(), &refused);
        assert_eq!(
            status_response(&path).unwrap_err(),
            Fault::detail(503, "Local platform release status is unavailable")
        );
    }
    assert!(read_status(&root.path().join("absent.json")).is_err());
}
