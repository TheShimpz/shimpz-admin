//! A Team's Routines through the session socket: closed projections, the frozen run's challenge, and an answer that
//! no longer names an open challenge.

use admin_backend::json;

use crate::support::{
    Admin,
    session::{call, open, params, traced},
};

const RUN: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn a_routine_list_outside_its_closed_view_is_one_safe_code() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let leaked = traced(&json::object(vec![
        ("team_id", json::text("sales")),
        ("secret", json::text("x")),
    ]));
    admin
        .team
        .on("GET", "/v1/teams/sales/routines", 200, leaked);
    admin.team.on(
        "GET",
        &format!("/v1/teams/sales/routines/runs/{RUN}/diagnostics"),
        404,
        json::object(vec![
            ("code", json::text("routine-run-not-found")),
            ("detail", json::text("private")),
        ]),
    );
    let mut socket = open(&admin, &cookie).await;
    let (status, body) = call(
        &mut socket,
        "routines.list",
        params(&[("team_id", "sales")], None),
    )
    .await;
    assert_eq!(
        (status, body),
        (502, json::code("routine-response-invalid"))
    );
    let (status, body) = call(
        &mut socket,
        "routines.diagnostics",
        params(&[("team_id", "sales"), ("run_id", RUN)], None),
    )
    .await;
    assert_eq!((status, body), (404, json::code("routine-run-not-found")));
    let (status, _) = call(
        &mut socket,
        "routines.diagnostics",
        params(&[("team_id", "sales"), ("run_id", "x")], None),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn a_run_waiting_for_an_integration_passes_its_exact_answer() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let waiting = json::object(vec![
        ("team_id", json::text("sales")),
        ("run_id", json::text(RUN)),
        ("status", json::text("integrations-required")),
    ]);
    admin.team.on(
        "POST",
        &format!("/v1/teams/sales/routines/runs/{RUN}/challenge"),
        200,
        traced(&waiting),
    );
    let mut socket = open(&admin, &cookie).await;
    let opening = json::object(vec![("locale", json::text("en"))]);
    let ids = [("team_id", "sales"), ("run_id", RUN)];
    let (status, body) = call(
        &mut socket,
        "routines.challenge",
        params(&ids, Some(opening)),
    )
    .await;
    assert_eq!((status, body), (200, waiting));
}

#[tokio::test]
async fn an_answer_to_no_open_challenge_is_expired_and_resumes_nothing() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let mut socket = open(&admin, &cookie).await;
    let frame = json::object(vec![
        ("type", json::text("human-response")),
        ("challenge_id", json::text("f".repeat(32))),
        ("decision", json::text("deny")),
    ]);
    let ids = [("team_id", "sales"), ("run_id", RUN)];
    let (status, body) = call(&mut socket, "routines.human", params(&ids, Some(frame))).await;
    assert_eq!((status, body), (409, json::code("human-request-expired")));
    let (status, body) = call(
        &mut socket,
        "routines.human",
        params(&ids, Some(json::empty())),
    )
    .await;
    assert_eq!(
        (status, body),
        (400, json::detail("human response is invalid"))
    );
    assert!(
        admin
            .team
            .requests()
            .iter()
            .all(|request| !request.path.ends_with("/human"))
    );
}
