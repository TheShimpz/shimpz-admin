use std::os::unix::fs::PermissionsExt;

use super::*;

const CAPABILITY: &str = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

fn digest() -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(
        data_encoding::HEXLOWER
            .decode(CAPABILITY.as_bytes())
            .unwrap(),
    ))
}

fn app(root: &std::path::Path) -> Arc<App> {
    let mut config = crate::config::Config::under(root);
    std::fs::create_dir_all(config.reset_capability_path.parent().unwrap()).unwrap();
    config.space_id = "space-0123456789abcdef01234567".to_owned();
    App::new(config)
}

fn write(app: &App, document: &str) {
    let path = &app.config.reset_capability_path;
    fsio::replace_atomically(path, document.as_bytes()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn document(space: &str, created: i64, expires: i64, digest: &str) -> String {
    format!(
        "{{\"version\":1,\"purpose\":\"space-reset\",\"space_id\":\"{space}\",\"created_at\":{created},\"expires_at\":{expires},\"capability_sha256\":\"{digest}\"}}"
    )
}

use std::sync::Arc;

#[tokio::test]
async fn only_the_capability_the_private_file_digests_within_its_window_authorizes() {
    let root = tempfile::tempdir().unwrap();
    let app = app(root.path());
    let now = 1_800_000_000;
    let space = app.config.space_id.clone();
    write(&app, &document(&space, now - 10, now + 60, &digest()));
    assert_eq!(
        verify_capability(&app, &json::text(CAPABILITY), now),
        Ok((digest(), now + 60))
    );
    assert!(verify_capability(&app, &json::text("f".repeat(64)), now).is_err());
    assert!(verify_capability(&app, &json::text(CAPABILITY.to_uppercase()), now).is_err());
    for refused in [
        document(
            "space-ffffffffffffffffffffffff",
            now - 10,
            now + 60,
            &digest(),
        ),
        document(&space, now - 200, now + 60, &digest()),
        document(&space, now - 10, now + 200, &digest()),
        document(&space, now, now, &digest()),
        format!(
            "{{\"version\":2{}",
            &document(&space, now - 10, now + 60, &digest())[12..]
        ),
    ] {
        write(&app, &refused);
        assert!(
            verify_capability(&app, &json::text(CAPABILITY), now).is_err(),
            "{refused}"
        );
    }
    write(&app, &document(&space, now - 10, now + 60, &digest()));
    std::fs::set_permissions(
        &app.config.reset_capability_path,
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    assert!(verify_capability(&app, &json::text(CAPABILITY), now).is_err());
}
