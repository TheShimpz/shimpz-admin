//! The Browser view relay: admitted as Admin's own page, then binary messages relayed both ways to Team's stream.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite;

use crate::support::{
    Admin,
    session::{borrowed, page_headers},
    socket::connect,
};

const VIEW: &str = "0123456789abcdef0123456789abcdef";

async fn echo(mut socket: WebSocket) {
    while let Some(Ok(Message::Binary(data))) = socket.next().await {
        if socket.send(Message::Binary(data)).await.is_err() {
            return;
        }
    }
}

/// A Team that serves one view stream, echoing what it receives, only to Admin's bearer.
async fn display() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new().route(
        "/v1/teams/sales/browser/views/{view}/stream",
        axum::routing::get(
            |headers: axum::http::HeaderMap, upgrade: WebSocketUpgrade| async move {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer team-bearer-token"
                );
                assert!(headers.get("x-shimpz-supervisor").is_some());
                upgrade.protocols(["binary"]).on_upgrade(echo)
            },
        ),
    );
    tokio::spawn(async move { axum::serve(listener, router).await });
    url
}

/// What easi.run's viewer sends from Admin's page: no subprotocol.
fn viewer_headers(cookie: &str) -> Vec<(&'static str, String)> {
    page_headers(cookie, "")
        .into_iter()
        .filter(|(name, _)| *name != "sec-websocket-protocol")
        .collect()
}

#[tokio::test]
async fn a_page_s_stream_is_relayed_to_team_and_back_as_binary() {
    let team = display().await;
    let admin = Admin::start_with(move |config| config.team_url = team).await;
    let cookie = admin.signed_in();
    let path = format!("/api/teams/sales/browser/views/{VIEW}/stream");
    let headers = viewer_headers(&cookie);
    let mut stream = connect(&admin.url, &path, &borrowed(&headers))
        .await
        .unwrap();
    stream
        .send(tungstenite::Message::binary(vec![1, 2, 3]))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
        .await
        .unwrap();
    assert_eq!(
        echoed.unwrap().unwrap(),
        tungstenite::Message::binary(vec![1, 2, 3])
    );
}

#[tokio::test]
async fn a_stream_outside_admin_s_page_or_protocol_is_refused_before_it_is_accepted() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    let path = format!("/api/teams/sales/browser/views/{VIEW}/stream");
    let mut foreign = viewer_headers(&cookie);
    foreign[0].1 = "https://evil.example".to_owned();
    assert_eq!(
        connect(&admin.url, &path, &borrowed(&foreign)).await.err(),
        Some(403)
    );
    let other = page_headers(&cookie, "binary");
    assert_eq!(
        connect(&admin.url, &path, &borrowed(&other)).await.err(),
        Some(403)
    );
    let signed_out = viewer_headers("v3:1:x:totp:y");
    assert_eq!(
        connect(&admin.url, &path, &borrowed(&signed_out))
            .await
            .err(),
        Some(403)
    );
    let invalid = viewer_headers(&cookie);
    let mut ended = connect(
        &admin.url,
        "/api/teams/sales/browser/views/nope/stream",
        &borrowed(&invalid),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::support::socket::next(&mut ended).await.err(),
        Some(4404)
    );
}
