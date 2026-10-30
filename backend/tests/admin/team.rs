//! The Team methods through the session socket against the fake Team: the saved order, creation's free id, the
//! Sign-in session's authority, and the closed projections the page receives.

use admin_backend::json::{self, Value};

use crate::support::{
    Admin, ORIGIN,
    session::{call, eventually, open, params, traced},
    team::Answer,
};

fn inventory(ids: &[&str]) -> Value {
    let teams = ids
        .iter()
        .map(|id| {
            json::object(vec![
                ("team_id", json::text(*id)),
                ("team_name", json::text(id.to_uppercase())),
                ("status", json::text("running")),
            ])
        })
        .collect();
    traced(&json::object(vec![("teams", Value::Array(teams))]))
}

fn listed(body: &Value) -> Vec<String> {
    json::as_array(body.get("teams").unwrap())
        .unwrap()
        .iter()
        .map(|team| json::get_str(team, "team_id").unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_team_list_follows_the_saved_order_under_the_supervisor_s_assertion() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin
        .team
        .on("GET", "/v1/teams", 200, inventory(&["c", "b", "a"]));
    admin_backend::fsio::replace_atomically(
        &admin.app.config.team_order_path,
        b"{\"team_ids\":[\"a\",\"c\"]}",
    )
    .unwrap();
    let mut socket = open(&admin, &cookie).await;
    let (status, body) = call(&mut socket, "teams.list", json::empty()).await;
    assert_eq!(status, 200);
    assert_eq!(listed(&body), ["b", "a", "c"]);
    let request = &admin.team.requests_to("/v1/teams")[0];
    assert!(
        matches!(request.assertion, Some(Ok(_))),
        "{:?}",
        request.assertion
    );
}

#[tokio::test]
async fn a_reorder_saves_only_an_exact_permutation_of_the_current_teams() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin
        .team
        .on("GET", "/v1/teams", 200, inventory(&["b", "a"]));
    let mut socket = open(&admin, &cookie).await;
    let reorder = |ids: &[&str]| {
        params(
            &[],
            Some(json::object(vec![(
                "team_ids",
                json::strings(ids.iter().copied()),
            )])),
        )
    };
    let (status, body) = call(&mut socket, "teams.reorder", reorder(&["a"])).await;
    assert_eq!(
        (status, json::get_str(&body, "code")),
        (409, Some("team-order-stale"))
    );
    assert!(!admin.app.config.team_order_path.exists());
    let (status, body) = call(&mut socket, "teams.reorder", reorder(&["a", "b"])).await;
    assert_eq!(
        (status, listed(&body)),
        (200, vec!["a".to_owned(), "b".to_owned()])
    );
    let saved = std::fs::read_to_string(&admin.app.config.team_order_path).unwrap();
    assert_eq!(saved, "{\"team_ids\":[\"a\",\"b\"]}");
}

#[tokio::test]
async fn a_name_held_by_another_team_takes_the_next_free_id() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.team.on(
        "POST",
        "/v1/teams/sales/create",
        409,
        json::object(vec![("code", json::text("team-name-conflict"))]),
    );
    let created = traced(&json::object(vec![
        ("created", Value::Bool(true)),
        ("team_id", json::text("sales_2")),
    ]));
    admin
        .team
        .on("POST", "/v1/teams/sales_2/create", 200, created);
    let mut socket = open(&admin, &cookie).await;
    let body = json::object(vec![("team_name", json::text(" Sales "))]);
    let (status, _) = call(&mut socket, "teams.create", params(&[], Some(body))).await;
    assert_eq!(status, 200);
    let sent = admin.team.requests_to("/v1/teams/sales_2/create")[0].json();
    assert_eq!(sent, json::object(vec![("team_name", json::text("Sales"))]));
    let (status, body) = call(
        &mut socket,
        "teams.create",
        params(&[], Some(json::object(vec![("team_name", json::int(1))]))),
    )
    .await;
    assert_eq!(
        (status, body),
        (400, json::detail("team name must be a string"))
    );
}

/// Scripts a Sign-in session Team starts and cancels; the started answer the page should receive.
fn script_sign_in(admin: &Admin, session_id: &str) -> Value {
    let started = json::object(vec![
        ("sign_in_session_id", json::text(session_id)),
        ("view_id", json::text("d".repeat(32))),
        ("site", json::text("example.com")),
    ]);
    admin.team.on(
        "POST",
        "/v1/teams/sales/browser/sign-in",
        200,
        traced(&started),
    );
    let cancelled = traced(&json::object(vec![("cancelled", Value::Bool(true))]));
    admin.team.on(
        "POST",
        "/v1/teams/sales/browser/sign-in/cancel",
        200,
        cancelled,
    );
    started
}

const CANCEL: &str = "/v1/teams/sales/browser/sign-in/cancel";

#[tokio::test]
async fn a_sign_in_session_names_the_page_s_origin_and_ends_with_its_supervisor_session() {
    let admin = Admin::start().await;
    admin_backend::team::sign_ins::listen(&admin.app);
    let cookie = admin.signed_in();
    let session_id = "c".repeat(32);
    let started = script_sign_in(&admin, &session_id);
    let mut socket = open(&admin, &cookie).await;
    let body = json::object(vec![
        ("url", json::text("https://example.com/login")),
        ("locale", json::text("en")),
        ("origin", json::text("https://evil.example")),
    ]);
    let (status, answer) = call(
        &mut socket,
        "sign_in.start",
        params(&[("team_id", "sales")], Some(body)),
    )
    .await;
    assert_eq!((status, answer), (200, started));
    let sent = admin.team.requests_to("/v1/teams/sales/browser/sign-in")[0].json();
    assert_eq!(json::get_str(&sent, "origin"), Some(ORIGIN));
    admin.app.sessions.end_all();
    assert!(eventually(|| !admin.team.requests_to(CANCEL).is_empty()).await);
    let cancel = admin.team.requests_to(CANCEL)[0].json();
    assert_eq!(
        json::get_str(&cancel, "sign_in_session_id"),
        Some(session_id.as_str())
    );
}

#[tokio::test]
async fn a_team_answer_outside_its_closed_shape_never_reaches_the_page() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let leaked = traced(&json::object(vec![
        ("team_id", json::text("sales")),
        ("assistant_id", json::text("notes")),
        ("stored_input_id", json::text("token")),
        ("cleared", Value::Bool(true)),
        ("value", json::text("sk-secret")),
    ]));
    admin.team.on(
        "DELETE",
        "/v1/teams/sales/assistant-stored-inputs/notes/token",
        200,
        leaked,
    );
    let foreign = json::object(vec![
        ("code", json::text("other")),
        ("detail", json::text("secret")),
    ]);
    admin
        .team
        .on("GET", "/v1/teams/sales/browser/sign-in", 409, foreign);
    let mut socket = open(&admin, &cookie).await;
    let ids = [
        ("team_id", "sales"),
        ("assistant_id", "notes"),
        ("stored_input_id", "token"),
    ];
    let (status, body) = call(&mut socket, "stored_inputs.clear", params(&ids, None)).await;
    assert_eq!(
        (status, body),
        (
            502,
            json::detail("Assistant Stored Input clear response is invalid.")
        )
    );
    let (status, body) = call(
        &mut socket,
        "sign_in.read",
        params(&[("team_id", "sales")], None),
    )
    .await;
    assert_eq!((status, body), (502, json::detail("team unavailable")));
}

#[tokio::test]
async fn a_request_admin_refuses_before_team_is_the_page_s_own_400() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let mut socket = open(&admin, &cookie).await;
    let (status, body) = call(
        &mut socket,
        "stored_inputs.list",
        params(&[("team_id", "Sales!")], None),
    )
    .await;
    assert_eq!(status, 400);
    assert!(json::get_str(&body, "detail").is_some());
    assert!(admin.team.requests().is_empty());
}

#[tokio::test]
async fn an_install_says_it_started_before_its_result() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.team.script(|request| {
        (request.path == "/v1/teams/sales/assistants/local").then(|| {
            Answer::Json(
                200,
                traced(&json::object(vec![("installed", Value::Bool(true))])),
            )
        })
    });
    let mut socket = open(&admin, &cookie).await;
    let image = format!("sha256:{}", "e".repeat(64));
    let body = json::object(vec![("image_id", json::text(&image))]);
    let mut seen = Vec::new();
    let result = crate::support::session::call_seeing(
        &mut socket,
        "assistants.install_local",
        params(&[("team_id", "sales")], Some(body)),
        &mut seen,
    )
    .await;
    assert_eq!(json::get(&result, "status"), Some(&json::int(200)));
    assert!(
        seen.iter()
            .any(|frame| json::get_str(frame, "type") == Some("progress"))
    );
}
