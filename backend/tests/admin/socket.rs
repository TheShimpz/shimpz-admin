//! The session socket through the real WebSocket transport: its handshake admission, its close codes, its calls, and
//! a started operation that outlives the socket that asked for it.

use std::time::Duration;

use admin_backend::json::{self, Value};

use crate::support::{
    Admin, ORIGIN,
    socket::{connect, next, send_frame},
};

const PATH: &str = "/api/session/ws";

fn page(cookie: &str) -> Vec<(&'static str, String)> {
    vec![
        ("origin", ORIGIN.to_owned()),
        ("sec-fetch-site", "same-origin".to_owned()),
        ("sec-websocket-protocol", "shimpz.admin.v1".to_owned()),
        ("cookie", format!("shimpz_admin={cookie}")),
    ]
}

fn borrowed<'a>(headers: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

async fn open(admin: &Admin, cookie: &str) -> crate::support::socket::Socket {
    let headers = page(cookie);
    let mut socket = connect(&admin.url, PATH, &borrowed(&headers))
        .await
        .unwrap();
    let first = next(&mut socket).await.unwrap();
    assert_eq!(json::get_str(&first, "type"), Some("session"));
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

#[tokio::test]
async fn a_handshake_outside_admin_s_page_or_session_is_refused_before_it_is_accepted() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let mut headers = page(&cookie);
    headers[0].1 = "http://admin.example.org".to_owned();
    assert_eq!(
        connect(&admin.url, PATH, &borrowed(&headers)).await.err(),
        Some(403)
    );
    let mut headers = page(&cookie);
    headers[2].1 = "shimpz.admin.v1, other".to_owned();
    assert_eq!(
        connect(&admin.url, PATH, &borrowed(&headers)).await.err(),
        Some(403)
    );
    let headers = page("v3:1:x:totp:y");
    assert_eq!(
        connect(&admin.url, PATH, &borrowed(&headers)).await.err(),
        Some(403)
    );
    let headers = page(&cookie);
    let plain =
        crate::support::client::send(&admin.url, "GET", PATH, &borrowed(&headers), Vec::new())
            .await;
    assert_eq!(plain.status, 404);
}

#[tokio::test]
async fn each_frame_outside_the_protocol_closes_with_its_own_code() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let cases: [(tokio_tungstenite::tungstenite::Message, u16); 4] = [
        (
            tokio_tungstenite::tungstenite::Message::binary(vec![1, 2]),
            1003,
        ),
        (
            tokio_tungstenite::tungstenite::Message::text(
                "{\"type\":\"activity\",\"type\":\"activity\"}",
            ),
            1007,
        ),
        (
            tokio_tungstenite::tungstenite::Message::text(format!(
                "{{\"x\":\"{}\"}}",
                "a".repeat(140 * 1024)
            )),
            1009,
        ),
        (
            tokio_tungstenite::tungstenite::Message::text(
                "{\"type\":\"call\",\"id\":\"1\",\"method\":\"nope\",\"params\":{}}",
            ),
            1008,
        ),
    ];
    for (message, code) in cases {
        let mut socket = open(&admin, &cookie).await;
        futures_util::SinkExt::send(&mut socket, message)
            .await
            .unwrap();
        assert_eq!(next(&mut socket).await.err(), Some(code));
    }
}

#[tokio::test]
async fn a_read_answers_with_its_topic_revision_and_a_change_is_announced() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let mut socket = open(&admin, &cookie).await;
    let topics = json::object(vec![(
        "topics",
        Value::Array(vec![json::text("space/models")]),
    )]);
    send_frame(&mut socket, &call("s", "subscribe", topics)).await;
    let subscribed = next(&mut socket).await.unwrap();
    assert_eq!(json::get(&subscribed, "status"), Some(&json::int(200)));
    send_frame(&mut socket, &call("m", "models.list", json::empty())).await;
    let listed = next(&mut socket).await.unwrap();
    assert_eq!(json::get_str(&listed, "id"), Some("m"));
    assert_eq!(json::get_str(&listed, "topic"), Some("space/models"));
    assert_eq!(json::get(&listed, "revision"), Some(&json::int(0)));
    admin.app.topics.changed("space/models");
    let changed = next(&mut socket).await.unwrap();
    assert_eq!(json::get_str(&changed, "type"), Some("changed"));
    assert_eq!(json::get(&changed, "revision"), Some(&json::int(1)));
}

#[tokio::test]
async fn every_socket_of_an_ended_session_closes_as_signed_out() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let mut socket = open(&admin, &cookie).await;
    admin.app.sessions.end_all();
    assert_eq!(next(&mut socket).await.err(), Some(4401));
}

/// A provider that confirms any key only after a while.
async fn slow_provider() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().fallback(|| async {
        tokio::time::sleep(Duration::from_millis(400)).await;
        "{}"
    });
    tokio::spawn(async move { axum::serve(listener, router).await });
    address
}

#[tokio::test]
async fn a_started_key_save_completes_after_its_socket_closes() {
    let provider = slow_provider().await;
    let admin = Admin::start_with(|config| {
        config.outbound = admin_backend::process::config::Outbound::Local(provider);
    })
    .await;
    let cookie = admin.signed_in();
    let mut socket = open(&admin, &cookie).await;
    let body = json::object(vec![("api_key", json::text("sk-test-key-0123456789"))]);
    let params = json::object(vec![("provider", json::text("openai")), ("body", body)]);
    send_frame(&mut socket, &call("save", "models.save", params)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(socket);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let saved =
        admin_backend::space::keys::models::resolve_api_key(&admin.app.store, "openai").unwrap();
    assert_eq!(saved.as_deref(), Some("sk-test-key-0123456789"));
}
