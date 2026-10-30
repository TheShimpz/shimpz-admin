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

const CHALLENGE: &str = "abcdefabcdefabcdefabcdefabcdefab";

fn integration_challenge() -> Value {
    traced(parsed(&format!(
        r#"{{"team_id":"marketing","status":"integrations-required","turn_id":"{CHALLENGE}","challenge_id":"{CHALLENGE}",
        "expires_in":600,"requirements":[{{"assistant_id":"cloudflare","assistant_name":"Cloudflare",
        "integration_id":"cloudflare","provider":"cloudflare","name":"Cloudflare","summary":"DNS access.",
        "scopes":["zone.read"],"actions":[{{"id":"list-zones","name":"List zones","summary":"Lists zones."}}]}}]}}"#
    )))
}

/// A turn Team pauses for an Integration, which a later continuation completes.
fn script_resume(admin: &Admin) {
    let pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    admin.team.script(move |request| match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/v1/teams/marketing/chat") => {
            pending.store(true, std::sync::atomic::Ordering::SeqCst);
            Some(Answer::Stream(Vec::new(), 428, integration_challenge()))
        }
        ("GET", "/v1/teams/marketing/chat/integrations") if pending.load(std::sync::atomic::Ordering::SeqCst) => {
            Some(Answer::Json(200, integration_challenge()))
        }
        ("POST", "/v1/teams/marketing/chat/integrations") => Some(Answer::Stream(
            Vec::new(),
            200,
            traced(parsed(r#"{"team_id":"marketing","team_name":"Marketing","reply":"Connected and listed.","clarification":null}"#)),
        )),
        _ => None,
    });
}

#[tokio::test]
async fn a_paused_turn_resumes_after_its_integration_and_keeps_its_reply() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    script_resume(&admin);
    send_frame(&mut socket, &message("List my DNS zones")).await;
    let challenge = until(&mut socket, "integrations-required").await;
    assert_eq!(json::get_str(&challenge, "challenge_id"), Some(CHALLENGE));
    assert!(!json::contains(&challenge, "trace_id") && !json::contains(&challenge, "turn_id"));
    let sync = json::object(vec![
        ("type", json::text("sync")),
        ("team_id", json::text("marketing")),
        ("locale", json::text("en")),
    ]);
    send_frame(&mut socket, &sync).await;
    let done = until(&mut socket, "done").await;
    assert_eq!(json::get_str(&done, "reply"), Some("Connected and listed."));
    let resume = admin
        .team
        .requests_to("/v1/teams/marketing/chat/integrations");
    let posted: Vec<_> = resume
        .iter()
        .filter(|request| request.method == "POST")
        .collect();
    assert_eq!(
        posted[0].json(),
        json::object(vec![("challenge_id", json::text(CHALLENGE))])
    );
    let store = &admin.app.domains.history.store;
    assert_eq!(store.resumable_turn("marketing").unwrap(), None);
    let page = store.page("marketing", None, None).unwrap();
    let texts: Vec<&str> = json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .filter_map(|entry| json::get_str(entry, "text"))
        .collect();
    assert_eq!(texts, ["List my DNS zones", "Connected and listed."]);
}

#[tokio::test]
async fn the_history_and_integrations_methods_answer_their_closed_shapes() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    let team = json::object(vec![("team_id", json::text("marketing"))]);
    send_frame(&mut socket, &call("page", "history.page", team.clone())).await;
    let page = until(&mut socket, "result").await;
    assert_eq!(json::get(&page, "status"), Some(&json::int(200)));
    assert_eq!(
        json::get_str(&page, "topic"),
        Some("team/marketing/history")
    );
    admin.team.on(
        "GET",
        "/v1/teams/marketing/assistant-integrations",
        200,
        traced(parsed(r#"{"team_id":"marketing","integrations":[{"assistant_id":"cloudflare","assistant_name":"Cloudflare",
        "assistant_version":"1.0.0","assistant_summary":"Manage DNS.","id":"cloudflare","provider":"cloudflare",
        "name":"Cloudflare","summary":"DNS access.","scopes":["zone.read"],"status":"connected",
        "integration":{"id":"acct","name":null,"username":null},"expires_at":null,"token":"secret"}]}"#)),
    );
    send_frame(&mut socket, &call("list", "integrations.list", team)).await;
    let listed = until(&mut socket, "result").await;
    assert_eq!(
        json::get(&listed, "status"),
        Some(&json::int(502)),
        "an extra field fails the whole inventory closed"
    );
    assert!(!json::compact(&listed).contains("secret"));
}

/// A fake public Store serving one catalog of `cloudflare` in every locale it is asked for.
async fn store_catalog() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().route(
        "/api/assistants",
        axum::routing::get(|| async {
            let digest = format!("sha256:{}", "a".repeat(64));
            let body = format!(
                r#"{{"version":1,"locale":"en","assistants":[{{"assistant_id":"cloudflare","name":"Cloudflare",
                "summary":"Manage DNS records.","description":"Manage DNS records in Cloudflare.","links":{{}},
                "assistant_version":"1.2.3","creators":["@shimpz"],"github":"https://github.com/theshimpz/cloudflare",
                "icon_digest":"{digest}","source_digest":"{digest}","platforms":["linux/amd64","linux/arm64"],
                "allowed_hosts":["api.cloudflare.com"],"integrations":[{{"id":"cloudflare","provider":"cloudflare",
                "scopes":["zone.read"]}}],"stored_inputs":[],"actions":[{{"id":"list-zones","integrations":["cloudflare"],
                "human_requests":[],"effect":"read_only","description":"List zones."}}]}}]}}"#
            );
            ([("content-type", "application/json")], body)
        }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await });
    address
}

fn script_install(admin: &Admin) {
    let installed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    admin.team.on(
        "GET",
        "/v1/local-assistants",
        200,
        traced(parsed(r#"{"assistants":[]}"#)),
    );
    admin.team.script(move |request| match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/v1/teams/marketing/chat/intent-route") => {
            let selection = json::get_str(&request.json(), "expected_intent").is_some();
            let body = if selection {
                r#"{"team_id":"marketing","intent":"assistant-install","query":"","assistant_ids":["cloudflare"],"reply":"","task_follows":false}"#
            } else {
                r#"{"team_id":"marketing","intent":"assistant-install","query":"cloudflare","assistant_ids":[],"reply":"","task_follows":false}"#
            };
            Some(Answer::Json(200, traced(parsed(body))))
        }
        ("POST", "/v1/teams/marketing/assistants") => {
            installed.store(true, std::sync::atomic::Ordering::SeqCst);
            Some(Answer::Json(200, traced(parsed(r#"{"assistant":"cloudflare","installed":true}"#))))
        }
        ("GET", "/v1/teams/marketing/assistants") if installed.load(std::sync::atomic::Ordering::SeqCst) => Some(Answer::Json(
            200,
            traced(parsed(r#"{"assistants":[{"assistant":"cloudflare","assistant_version":"1.2.3","provenance":"published","status":"running"}]}"#)),
        )),
        _ => None,
    });
}

#[tokio::test]
async fn an_install_request_runs_its_plan_and_keeps_its_card() {
    let store = store_catalog().await;
    let admin =
        Admin::start_with(|config| config.outbound = admin_backend::config::Outbound::Local(store))
            .await;
    let mut socket = attached(&admin).await;
    script_install(&admin);
    send_frame(&mut socket, &message("Install Cloudflare")).await;
    let planned = until(&mut socket, "assistant-install-plan").await;
    assert_eq!(json::get_str(&planned, "state"), Some("planned"));
    let terminal = loop {
        let event = until(&mut socket, "assistant-install-plan").await;
        if json::get_str(&event, "state") != Some("installing") {
            break event;
        }
    };
    assert_eq!(json::get_str(&terminal, "state"), Some("installed"));
    assert_eq!(json::get_str(&terminal, "continuation"), Some("none"));
    let item = &json::as_array(terminal.get("assistants").unwrap()).unwrap()[0];
    assert_eq!(json::get_str(item, "creator"), Some("@shimpz"));
    let installs = admin
        .team
        .requests()
        .into_iter()
        .filter(|request| {
            request.method == "POST" && request.path == "/v1/teams/marketing/assistants"
        })
        .count();
    assert_eq!(installs, 1);
    assert!(
        admin
            .team
            .requests_to("/v1/teams/marketing/chat")
            .is_empty(),
        "an install-only request never reaches the Brain"
    );
    let page = admin
        .app
        .domains
        .history
        .store
        .page("marketing", None, None)
        .unwrap();
    let kinds: Vec<&str> = json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .filter_map(|entry| json::get_str(entry, "kind"))
        .collect();
    assert_eq!(kinds, ["message", "assistant-install"]);
}

#[tokio::test]
async fn stopping_a_paused_turn_ends_it_once_team_confirms() {
    let admin = Admin::start().await;
    let mut socket = attached(&admin).await;
    admin.team.script(|request| {
        (request.method == "POST" && request.path == "/v1/teams/marketing/chat")
            .then(|| Answer::Stream(Vec::new(), 428, integration_challenge()))
    });
    admin.team.on(
        "POST",
        "/v1/teams/marketing/chat/stop",
        200,
        traced(parsed(r#"{"team_id":"marketing","requested":true,"accepted":true,"confirmed":false,"forced_restart":false}"#)),
    );
    send_frame(&mut socket, &message("List my DNS zones")).await;
    until(&mut socket, "integrations-required").await;
    let store = &admin.app.domains.history.store;
    assert!(store.resumable_turn("marketing").unwrap().is_some());
    let stop = json::object(vec![
        ("type", json::text("stop")),
        ("team_id", json::text("marketing")),
    ]);
    send_frame(&mut socket, &stop).await;
    until(&mut socket, "stopped").await;
    assert_eq!(store.resumable_turn("marketing").unwrap(), None);
    let page = store.page("marketing", None, None).unwrap();
    let last = json::as_array(page.get("entries").unwrap())
        .unwrap()
        .last()
        .cloned()
        .unwrap();
    assert_eq!(
        (json::get_str(&last, "kind"), json::get_str(&last, "state")),
        (Some("status"), Some("stopped"))
    );
}
