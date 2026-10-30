//! A Team's files over HTTP: the bounded multipart upload reaches Team as raw bytes, and a file's renditions and
//! original reach only Admin's own page.

use crate::support::{Admin, ORIGIN, client::send};

const BOUNDARY: &str = "XyZ";

fn upload_body(content: &str) -> Vec<u8> {
    format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\n{content}\r\n--{BOUNDARY}--\r\n"
    )
    .into_bytes()
}

#[tokio::test]
async fn an_upload_reaches_team_as_its_raw_bytes_with_its_name() {
    let admin = Admin::start().await;
    let cookie = format!("shimpz_admin={}", admin.signed_in());
    admin.team.on(
        "POST",
        "/v1/teams/sales/files",
        404,
        admin_backend::json::detail("Team not found"),
    );
    let content_type = format!("multipart/form-data; boundary={BOUNDARY}");
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("sec-fetch-site", "same-origin"),
        ("content-type", content_type.as_str()),
    ];
    let answer = send(
        &admin.url,
        "POST",
        "/api/teams/sales/files",
        &headers,
        upload_body("hello"),
    )
    .await;
    assert_eq!(answer.status, 404);
    let sent = &admin.team.requests_to("/v1/teams/sales/files")[0];
    assert_eq!(sent.body, b"hello");
    let wrong = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("content-type", "text/plain"),
    ];
    let answer = send(
        &admin.url,
        "POST",
        "/api/teams/sales/files",
        &wrong,
        upload_body("x"),
    )
    .await;
    assert_eq!(answer.status, 415);
    assert_eq!(admin.team.requests_to("/v1/teams/sales/files").len(), 1);
}

#[tokio::test]
async fn a_rendition_or_original_answers_only_admin_s_own_page() {
    let admin = Admin::start().await;
    let cookie = format!("shimpz_admin={}", admin.signed_in());
    let file = "f".repeat(32);
    for (path, destination) in [
        (format!("/api/teams/sales/files/{file}/preview"), "iframe"),
        (format!("/api/teams/sales/files/{file}/download"), "image"),
    ] {
        let headers = [
            ("cookie", cookie.as_str()),
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-dest", destination),
        ];
        let answer = send(&admin.url, "GET", &path, &headers, Vec::new()).await;
        assert_eq!(answer.status, 403, "{path}");
        assert_eq!(answer.header("cache-control"), Some("no-store"));
    }
    assert!(admin.team.requests().is_empty());
    admin.team.on(
        "GET",
        &format!("/v1/teams/sales/files/{file}/content"),
        404,
        admin_backend::json::code("file-not-found"),
    );
    let headers = [
        ("cookie", cookie.as_str()),
        ("sec-fetch-site", "same-origin"),
        ("sec-fetch-dest", "empty"),
    ];
    let answer = send(
        &admin.url,
        "GET",
        &format!("/api/teams/sales/files/{file}/download"),
        &headers,
        Vec::new(),
    )
    .await;
    assert_eq!(answer.status, 404);
    assert_eq!(answer.header("cache-control"), Some("no-store"));
}
