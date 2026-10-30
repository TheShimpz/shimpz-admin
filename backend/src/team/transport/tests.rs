use super::*;

#[test]
fn team_is_reached_only_at_a_plain_http_host_and_port() {
    assert_eq!(
        endpoint("http://team:7077"),
        Some(("team".to_owned(), 7077))
    );
    assert_eq!(endpoint("http://Team"), Some(("team".to_owned(), 7077)));
    assert_eq!(
        endpoint("http://team:7077/"),
        Some(("team".to_owned(), 7077))
    );
    for refused in [
        "https://team:7077",
        "http://team:7077/v1",
        "http://user@team:7077",
        "http://team:0",
        "http://:7077",
    ] {
        assert_eq!(endpoint(refused), None, "{refused}");
    }
}

#[test]
fn a_body_beyond_its_bound_is_refused_before_any_call() {
    let body = json::object(vec![("x", json::text("y".repeat(MAX_JSON_BODY_BYTES)))]);
    assert_eq!(
        encode(Some(&body), MAX_JSON_BODY_BYTES),
        Err(Fault::team_request(format!(
            "request body exceeds {MAX_JSON_BODY_BYTES} bytes"
        )))
    );
    assert!(encode(Some(&json::text("x")), MAX_JSON_BODY_BYTES).is_err());
}
