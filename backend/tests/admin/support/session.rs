//! A signed-in page's session socket: open it as Admin's own page does, and make one call at a time.

use admin_backend::json::{self, Value};

use super::{
    Admin, ORIGIN,
    socket::{Socket, connect, next, send_frame},
};

/// The headers Admin's own page opens a `WebSocket` with, under `protocol`.
#[must_use]
pub fn page_headers(cookie: &str, protocol: &str) -> Vec<(&'static str, String)> {
    vec![
        ("origin", ORIGIN.to_owned()),
        ("sec-fetch-site", "same-origin".to_owned()),
        ("sec-websocket-protocol", protocol.to_owned()),
        ("cookie", format!("shimpz_admin={cookie}")),
    ]
}

/// The headers as the client takes them.
#[must_use]
pub fn borrowed<'a>(headers: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect()
}

/// A session socket of `cookie`'s session, past its first `session` frame.
pub async fn open(admin: &Admin, cookie: &str) -> Socket {
    let headers = page_headers(cookie, "shimpz.admin.v1");
    let mut socket = connect(&admin.url, "/api/session/ws", &borrowed(&headers))
        .await
        .unwrap();
    let first = next(&mut socket).await.unwrap();
    assert_eq!(json::get_str(&first, "type"), Some("session"));
    socket
}

/// Sends one call and returns its result frame, keeping every other frame it saw meanwhile in `seen`.
pub async fn call_seeing(
    socket: &mut Socket,
    method: &str,
    params: Value,
    seen: &mut Vec<Value>,
) -> Value {
    let id = format!("c{}", seen.len());
    let frame = json::object(vec![
        ("type", json::text("call")),
        ("id", json::text(&id)),
        ("method", json::text(method)),
        ("params", params),
    ]);
    send_frame(socket, &frame).await;
    loop {
        let frame = next(socket).await.unwrap();
        if json::get_str(&frame, "type") == Some("result")
            && json::get_str(&frame, "id") == Some(id.as_str())
        {
            return frame;
        }
        seen.push(frame);
    }
}

/// Sends one call and returns its status and body.
pub async fn call(socket: &mut Socket, method: &str, params: Value) -> (i64, Value) {
    let frame = call_seeing(socket, method, params, &mut Vec::new()).await;
    (
        json::get(&frame, "status").and_then(json::as_int).unwrap(),
        json::get(&frame, "body").cloned().unwrap(),
    )
}

/// `{name: value}` params of text values and one optional body.
#[must_use]
pub fn params(texts: &[(&str, &str)], body: Option<Value>) -> Value {
    let mut members: Vec<(&str, Value)> = texts
        .iter()
        .map(|(name, value)| (*name, json::text(*value)))
        .collect();
    if let Some(body) = body {
        members.push(("body", body));
    }
    json::object(members)
}

/// A Team trace id.
#[must_use]
pub fn trace() -> Value {
    json::text("a".repeat(32))
}

/// `body` with Team's trace id.
#[must_use]
pub fn traced(body: &Value) -> Value {
    json::merged(body, &json::object(vec![("trace_id", trace())]))
}

/// Polls `condition` for up to five seconds.
pub async fn eventually(mut condition: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if condition() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    condition()
}
