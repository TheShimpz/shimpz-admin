//! The Supervisor gate: every non-open API route needs a current session and, to change state, Admin's own page; the
//! call then runs under that session's authority, which Team verifies.

use admin_backend::{json, team::bridge};

use crate::support::{Admin, ORIGIN, client};

#[tokio::test]
async fn an_api_route_without_a_session_is_refused_and_never_cached() {
    let admin = Admin::start().await;
    admin.signed_in();
    let answer = client::send(
        &admin.url,
        "GET",
        "/api/teams/marketing/files/a/download",
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(answer.status, 401);
    assert_eq!(answer.json(), json::detail("unauthenticated"));
    assert_eq!(answer.header("cache-control"), Some("no-store"));
    assert!(
        answer
            .header("content-security-policy")
            .is_some_and(|policy| policy.contains("frame-ancestors 'none'"))
    );
}

#[tokio::test]
async fn a_state_change_needs_admin_s_own_page() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let session = format!("shimpz_admin={cookie}");
    for headers in [
        vec![("cookie", session.as_str())],
        vec![
            ("cookie", session.as_str()),
            ("origin", "https://evil.example"),
        ],
        vec![
            ("cookie", session.as_str()),
            ("sec-fetch-site", "cross-site"),
        ],
        vec![
            ("cookie", session.as_str()),
            ("origin", ORIGIN),
            ("origin", ORIGIN),
        ],
    ] {
        let answer = client::send(
            &admin.url,
            "POST",
            "/api/teams/marketing/files",
            &headers,
            Vec::new(),
        )
        .await;
        assert_eq!(answer.status, 403, "{headers:?}");
        assert_eq!(
            answer.json(),
            json::detail("browser origin is not admitted")
        );
    }
    let answer = client::send(
        &admin.url,
        "POST",
        "/api/no-such-route",
        &[("cookie", session.as_str()), ("origin", ORIGIN)],
        Vec::new(),
    )
    .await;
    assert_eq!(answer.status, 404);
    assert_eq!(
        answer.json(),
        json::detail("unknown API endpoint: /api/no-such-route")
    );
}

#[tokio::test]
async fn team_verifies_the_supervisor_assertion_of_a_session_call() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.team.on(
        "GET",
        "/v1/teams",
        200,
        json::object(vec![
            ("teams", serde_free_list()),
            ("trace_id", json::text("0".repeat(32))),
        ]),
    );
    let team = admin.app.session_team(&cookie).unwrap();
    let response = bridge::list_teams(&team).await;
    assert_eq!(response.status, 200);
    let recorded = admin.team.requests_to("/v1/teams");
    let claims = recorded[0].assertion.clone().unwrap().unwrap();
    assert_eq!(json::get_str(&claims, "authority"), Some("session"));
    assert_eq!(json::get_str(&claims, "method"), Some("GET"));
}

fn serde_free_list() -> json::Value {
    json::Value::Array(Vec::new())
}
