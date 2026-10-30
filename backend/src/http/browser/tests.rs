use axum::http::{HeaderMap, HeaderName, HeaderValue, Method};

use super::*;

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

#[test]
fn only_admin_s_own_page_at_an_admitted_origin_changes_state() {
    let admitted = vec!["http://127.0.0.1:7777".to_owned()];
    let check =
        |pairs: &[(&str, &str)]| admits_unsafe_request(&Method::POST, &headers(pairs), &admitted);
    assert!(check(&[("sec-fetch-site", "same-origin")]));
    assert!(check(&[("origin", "http://127.0.0.1:7777")]));
    assert!(check(&[
        ("origin", "http://127.0.0.1:7777"),
        ("sec-fetch-site", "same-origin")
    ]));
    assert!(!check(&[]));
    assert!(!check(&[("sec-fetch-site", "same-site")]));
    assert!(!check(&[("origin", "http://localhost:7777")]));
    assert!(!check(&[
        ("origin", "http://127.0.0.1:7777"),
        ("sec-fetch-site", "cross-site")
    ]));
    assert!(!check(&[
        ("sec-fetch-site", "same-origin"),
        ("sec-fetch-site", "same-origin")
    ]));
    assert!(admits_unsafe_request(
        &Method::GET,
        &headers(&[]),
        &admitted
    ));
}

#[test]
fn the_page_policy_admits_only_its_scripts_and_admitted_sockets() {
    let policy = content_security_policy(
        &["'sha256-abc'".to_owned()],
        &[
            "https://admin.example.org".to_owned(),
            "http://127.0.0.1:7777".to_owned(),
        ],
    );
    assert!(policy.contains("script-src 'self' 'sha256-abc';"));
    assert!(policy.contains("connect-src 'self' ws://127.0.0.1:7777 wss://admin.example.org;"));
    assert!(
        policy.ends_with("require-trusted-types-for 'script'; trusted-types svelte-trusted-html")
    );
}

#[test]
fn cookies_and_fetch_metadata_are_read_as_the_browser_sends_them() {
    let map = headers(&[(
        "cookie",
        "a=1; shimpz_admin=v3:1:x:pwd+totp:y; shimpz_admin=\"z\"",
    )]);
    assert_eq!(cookie(&map, "shimpz_admin").as_deref(), Some("z"));
    assert!(same_origin_fetch(
        &headers(&[
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-dest", "image")
        ]),
        &IMAGE_DESTINATIONS
    ));
    assert!(!same_origin_fetch(
        &headers(&[
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-dest", "iframe")
        ]),
        &IMAGE_DESTINATIONS
    ));
}
