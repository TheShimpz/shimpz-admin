//! Destructive Local Space reset by host capability: exact one-use authority, the password once a Supervisor exists,
//! and a never-cached answer.

use std::os::unix::fs::PermissionsExt;

use admin_backend::json::{self, Value};
use sha2::{Digest, Sha256};

use crate::support::{Admin, client::send};

const CAPABILITY: &str = "1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e";

fn project_capability(admin: &Admin) {
    let digest = data_encoding::HEXLOWER.encode(&Sha256::digest(
        data_encoding::HEXLOWER
            .decode(CAPABILITY.as_bytes())
            .unwrap(),
    ));
    let now = admin.clock.now_secs();
    let document = json::object(vec![
        ("version", json::int(1)),
        ("purpose", json::text("space-reset")),
        ("space_id", json::text(&admin.app.config.space_id)),
        ("created_at", json::int(now - 5)),
        ("expires_at", json::int(now + 60)),
        ("capability_sha256", json::text(digest)),
    ]);
    let path = &admin.app.config.reset_capability_path;
    admin_backend::fsio::replace_atomically(path, json::compact(&document).as_bytes()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

async fn host_reset(admin: &Admin, body: &Value) -> crate::support::client::Answer {
    let headers = [("content-type", "application/json")];
    send(
        &admin.url,
        "DELETE",
        "/api/space/host",
        &headers,
        json::compact(body).into_bytes(),
    )
    .await
}

#[tokio::test]
async fn a_space_without_a_supervisor_is_reset_once_by_its_host_capability() {
    let admin = Admin::start().await;
    admin.team.on(
        "DELETE",
        "/v1/space/bootstrap",
        200,
        json::object(vec![("reset", Value::Bool(true))]),
    );
    project_capability(&admin);
    let body = json::object(vec![("capability", json::text(CAPABILITY))]);
    let answer = host_reset(&admin, &body).await;
    assert_eq!(
        (answer.status, answer.json()),
        (200, json::object(vec![("reset", Value::Bool(true))]))
    );
    assert_eq!(answer.header("cache-control"), Some("no-store"));
    let bootstrap = &admin.team.requests_to("/v1/space/bootstrap")[0];
    assert!(bootstrap.assertion.is_none());
    let replayed = host_reset(&admin, &body).await;
    assert_eq!(
        (replayed.status, replayed.json()),
        (403, json::detail("host reset authorization is unavailable"))
    );
    assert_eq!(admin.team.requests_to("/v1/space/bootstrap").len(), 1);
}

#[tokio::test]
async fn an_initialized_space_needs_the_password_and_a_wrong_capability_reaches_nothing() {
    let admin = Admin::start().await;
    admin.signed_in();
    project_capability(&admin);
    let only = host_reset(
        &admin,
        &json::object(vec![("capability", json::text(CAPABILITY))]),
    )
    .await;
    assert_eq!(only.status, 409);
    assert_eq!(
        json::get_str(&only.json(), "code"),
        Some("supervisor-password-required")
    );
    let wrong = host_reset(
        &admin,
        &json::object(vec![("capability", json::text("2".repeat(64)))]),
    )
    .await;
    assert_eq!(wrong.status, 403);
    assert!(admin.team.requests().is_empty());
}
