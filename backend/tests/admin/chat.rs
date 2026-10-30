//! Chat over the real session socket against a fake Team: a page attaches to a Team's run, sends a message that is
//! admitted into the Team's history, routed, and answered with its progress first; the model key reaches Team only in
//! its private headers, and the reply is kept for reload.

use std::time::Duration;

use admin_backend::json::{self, Value};

use crate::support::{
    Admin, ORIGIN,
    socket::{Socket, connect, next, send_frame},
    team::Answer,
};

const TRACE: &str = "0123456789abcdef0123456789abcdef";
const KEY: &str = "sk-test-model-key-0123456789";

fn traced(mut body: Value) -> Value {
    json::set(&mut body, "trace_id", json::text(TRACE));
    body
}

fn parsed(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap()
}

/// A fake Team with one running Team, `marketing`, nothing paused, and an ordinary-task route.
fn script_team(admin: &Admin) {
    let team = &admin.team;
    team.on(
        "GET",
        "/v1/teams",
        200,
        traced(parsed(
            r#"{"teams":[{"team_id":"marketing","team_name":"Marketing","status":"running"}]}"#,
        )),
    );
    team.on(
        "GET",
        "/v1/teams/marketing/inference",
        200,
        traced(parsed(
            r#"{"team_id":"marketing","provider":"openai","model":"gpt-6-luna"}"#,
        )),
    );
    team.on(
        "GET",
        "/v1/chat/limit",
        200,
        traced(parsed(r#"{"limit":1}"#)),
    );
    let none = traced(parsed(r#"{"team_id":"marketing","status":"none"}"#));
    team.on(
        "GET",
        "/v1/teams/marketing/chat/integrations",
        200,
        none.clone(),
    );
    team.on(
        "POST",
        "/v1/teams/marketing/chat/human/challenge",
        200,
        none,
    );
    team.on(
        "GET",
        "/v1/teams/marketing/assistants",
        200,
        traced(parsed(r#"{"assistants":[]}"#)),
    );
    script_turn(admin);
}

/// The route and the Team turn of one ordinary message.
fn script_turn(admin: &Admin) {
    let team = &admin.team;
    team.on(
        "POST",
        "/v1/teams/marketing/chat/intent-route",
        200,
        traced(parsed(
            r#"{"team_id":"marketing","intent":"ordinary-task","query":"","assistant_ids":[],"reply":"","task_follows":false}"#,
        )),
    );
    team.script(|request| {
        (request.method == "POST" && request.path == "/v1/teams/marketing/chat").then(|| {
            Answer::Stream(
                vec![parsed(r#"{"type":"progress","seq":1,"phase":"model","state":"started"}"#)],
                200,
                traced(parsed(r#"{"team_id":"marketing","team_name":"Marketing","reply":"Two zones are active.","clarification":null}"#)),
            )
        })
    });
}

async fn open(admin: &Admin, cookie: &str) -> Socket {
    let cookie = format!("shimpz_admin={cookie}");
    let headers = [
        ("origin", ORIGIN),
        ("sec-fetch-site", "same-origin"),
        ("sec-websocket-protocol", "shimpz.admin.v1"),
        ("cookie", cookie.as_str()),
    ];
    let mut socket = connect(&admin.url, "/api/session/ws", &headers)
        .await
        .unwrap();
    assert_eq!(
        json::get_str(&next(&mut socket).await.unwrap(), "type"),
        Some("session")
    );
    socket
}

fn call(id: &str, method: &str, params: Value) -> Value {
    json::object(vec![
        ("type", json::text("call")),
        ("id", json::text(id)),
        ("method", json::text(method)),
        ("params", params),
    ])
}

/// The next frame of `kind`, skipping any other.
async fn until(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), next(socket))
            .await
            .unwrap()
            .unwrap();
        if json::get_str(&frame, "type") == Some(kind) {
            return frame;
        }
    }
}

async fn attached(admin: &Admin) -> Socket {
    let cookie = admin.signed_in();
    admin.app.store.set_model_api_key("openai", KEY).unwrap();
    script_team(admin);
    let mut socket = open(admin, &cookie).await;
    let params = json::object(vec![
        ("team_id", json::text("marketing")),
        ("locale", json::text("en")),
    ]);
    send_frame(&mut socket, &call("attach", "chat.attach", params)).await;
    let result = until(&mut socket, "result").await;
    assert_eq!(json::get(&result, "status"), Some(&json::int(200)));
    let empty = until(&mut socket, "sync-empty").await;
    assert_eq!(json::get_str(&empty, "team_id"), Some("marketing"));
    socket
}

fn message(text: &str) -> Value {
    json::object(vec![
        ("type", json::text("chat")),
        ("team_id", json::text("marketing")),
        ("message", json::text(text)),
        ("files", Value::Array(Vec::new())),
        ("assistant_ids", Value::Array(Vec::new())),
        ("locale", json::text("en")),
        ("timezone", Value::Null),
        ("refine", Value::Null),
    ])
}

#[tokio::test]
async fn a_message_is_answered_after_its_progress_and_kept_for_reload() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    send_frame(&mut socket, &message("List my DNS zones")).await;
    let progress = until(&mut socket, "progress").await;
    assert_eq!(json::get_str(&progress, "team_id"), Some("marketing"));
    let done = until(&mut socket, "done").await;
    assert_eq!(json::get_str(&done, "reply"), Some("Two zones are active."));
    assert!(!json::contains(&done, "trace_id"));
    let turn = admin.team.requests_to("/v1/teams/marketing/chat");
    assert_eq!(turn.len(), 1);
    assert!(!String::from_utf8_lossy(&turn[0].body).contains(KEY));
    assert_eq!(turn[0].headers.get("x-shimpz-model-api-key").unwrap(), KEY);
    let route = admin
        .team
        .requests_to("/v1/teams/marketing/chat/intent-route");
    assert!(!String::from_utf8_lossy(&route[0].body).contains(KEY));
    let page = admin
        .app
        .domains
        .history
        .store
        .page("marketing", None, None)
        .unwrap();
    let texts: Vec<&str> = json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .filter_map(|entry| json::get_str(entry, "text"))
        .collect();
    assert_eq!(texts, ["List my DNS zones", "Two zones are active."]);
}

#[tokio::test]
async fn a_reply_that_echoes_the_key_is_refused_and_never_shown() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    admin.team.script(|request| {
        (request.method == "POST" && request.path == "/v1/teams/marketing/chat").then(|| {
            let body = json::object(vec![
                ("team_id", json::text("marketing")),
                ("team_name", json::text("Marketing")),
                ("reply", json::text(format!("your key is {KEY}"))),
                ("clarification", Value::Null),
                ("trace_id", json::text(TRACE)),
            ]);
            Answer::Stream(Vec::new(), 200, body)
        })
    });
    send_frame(&mut socket, &message("Show my key")).await;
    let error = until(&mut socket, "error").await;
    assert_eq!(json::get(&error, "status"), Some(&json::int(502)));
    assert!(!json::compact(&error).contains(KEY));
}

#[tokio::test]
async fn a_chat_frame_beyond_its_fields_is_refused_to_its_page() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    let mut invalid = message("x");
    json::set(&mut invalid, "extra", json::text("y"));
    send_frame(&mut socket, &invalid).await;
    let error = until(&mut socket, "error").await;
    assert_eq!(json::get(&error, "status"), Some(&json::int(400)));
}
