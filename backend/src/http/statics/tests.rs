use std::os::unix::fs::symlink;

use axum::{
    body::to_bytes,
    http::{HeaderMap, HeaderValue, Method},
};

use super::*;

fn build() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("_app/immutable")).unwrap();
    std::fs::write(
        root.path().join("index.html"),
        "<html><script>boot()</script><script src=\"/x.js\"></script></html>",
    )
    .unwrap();
    std::fs::write(root.path().join("_app/immutable/app.js"), "x".repeat(100)).unwrap();
    std::fs::write(root.path().join("_app/immutable/app.js.br"), "small").unwrap();
    std::fs::write(root.path().join("secret.txt"), "outside").unwrap();
    symlink(
        root.path().join("secret.txt"),
        root.path().join("_app/link.txt"),
    )
    .unwrap();
    root
}

#[test]
fn inline_scripts_are_hashed_as_the_page_policy_admits_them() {
    assert_eq!(
        inline_scripts("<SCRIPT type=module>a()</script><script src=x></script>"),
        vec!["a()".to_owned()]
    );
    let root = build();
    let site = Site::index(root.path());
    assert_eq!(site.script_sources.len(), 1);
    assert!(site.script_sources[0].starts_with("'sha256-"));
}

#[tokio::test]
async fn a_build_file_is_served_with_its_smaller_accepted_sibling() {
    let root = build();
    let site = Site::index(root.path());
    let mut headers = HeaderMap::new();
    headers.insert("accept-encoding", HeaderValue::from_static("gzip, br;q=1"));
    let response = site
        .serve(&Method::GET, "_app/immutable/app.js", &headers)
        .await;
    assert_eq!(response.headers()["content-encoding"], "br");
    assert_eq!(
        response.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        response.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(to_bytes(response.into_body(), 100).await.unwrap(), "small");
    headers.insert("accept-encoding", HeaderValue::from_static("br;q=0"));
    let response = site
        .serve(&Method::GET, "_app/immutable/app.js", &headers)
        .await;
    assert!(response.headers().get("content-encoding").is_none());
}

#[tokio::test]
async fn any_other_path_is_the_shell_and_a_link_or_sibling_is_never_served() {
    let root = build();
    let site = Site::index(root.path());
    for path in [
        "chat",
        "_app/link.txt",
        "_app/immutable/app.js.br",
        "../etc/passwd",
    ] {
        let response = site.serve(&Method::GET, path, &HeaderMap::new()).await;
        assert_eq!(response.headers()["cache-control"], "no-cache", "{path}");
        let body = to_bytes(response.into_body(), 1000).await.unwrap();
        assert!(body.starts_with(b"<html>"), "{path}");
    }
    let response = site.serve(&Method::POST, "chat", &HeaderMap::new()).await;
    assert_eq!(response.status(), 405);
}
