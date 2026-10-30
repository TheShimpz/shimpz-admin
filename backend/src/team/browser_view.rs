//! A Browser task's screen for the watching Supervisor: one binary `WebSocket` Admin relays to Team (ADR-0117).
//!
//! `GET /api/teams/{team_id}/browser/views/{view_id}/stream` is admitted exactly as the session socket is: one admitted
//! Origin, Fetch Metadata saying Admin's own page opened it, the exact subprotocol (`binary`), and a current Supervisor
//! session; it stays bound to that Origin and session, checked again every few seconds. Admin then reaches Team over a
//! connection of its own with the Supervisor's assertion for that exact path, and relays binary messages both ways with
//! send deadlines. The screen's bytes are never read, stored, or logged. At most [`MAX_STREAMS`] streams run at once,
//! and either side ending, the session ending, or its Origin no longer being admitted ends the stream.
//!
//! `…/control` is the same stream of a sign-in session's Browser, which the Supervisor also drives: Team alone decides
//! that the view offers control and grants it.

use std::{sync::Arc, time::Duration};

use axum::{
    extract::{
        FromRequestParts, Path, Request, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use team_protocol::browser_view as view_contract;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{self, client::IntoClientRequest, protocol::WebSocketConfig},
};

use crate::{
    app::{App, COOKIE},
    authority::{SessionStatus, session_status},
    http::{browser, respond},
    json,
    session::{registry::SIGNED_OUT, socket},
};

/// The streams relayed at once.
pub const MAX_STREAMS: usize = 2;
/// The largest message either side may send.
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const OPEN: Duration = Duration::from_secs(10);
const SEND: Duration = Duration::from_secs(10);
const CLOSE: Duration = Duration::from_secs(2);
const SESSION_CHECK: Duration = Duration::from_secs(5);
/// Team answered that the task no longer runs.
pub const ENDED: u16 = 4404;
/// The Space's streams are all in use.
pub const BUSY: u16 = 4429;
/// The view is unavailable.
pub const UNAVAILABLE: u16 = 1013;
/// The stream simply ended.
pub const FINISHED: u16 = 1000;

type TeamSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// What one admitted stream is bound to.
struct Bound {
    app: Arc<App>,
    origin: String,
    cookie: String,
}

impl Bound {
    /// Whether the session is still current and its Origin still admitted.
    fn admitted(&self) -> bool {
        let admitted = self
            .app
            .allowed_origins()
            .is_ok_and(|origins| origins.contains(&self.origin));
        admitted && session_status(&self.app, &self.cookie, false) == SessionStatus::Active
    }

    /// Returns once the session is no longer current or its Origin no longer admitted.
    async fn lapsed(&self) {
        while self.admitted() {
            tokio::time::sleep(SESSION_CHECK).await;
        }
    }
}

/// The page's admitted Origin and session cookie, or `None`: the handshake is refused before it is accepted.
fn admit(app: &App, headers: &HeaderMap) -> Option<(String, String)> {
    let Ok(origins) = app.allowed_origins() else {
        crate::command::log("error", "browser_stream_origin_authority_unavailable");
        return None;
    };
    let origin = socket::admitted_origin(headers, &origins)?;
    if socket::offered_protocols(headers) != [view_contract::SUBPROTOCOL] {
        return None;
    }
    let cookie = browser::cookie(headers, COOKIE).unwrap_or_default();
    (session_status(app, &cookie, false) == SessionStatus::Active).then_some((origin, cookie))
}

async fn upgrade(
    app: Arc<App>,
    request: Request,
    team_id: &str,
    view_id: &str,
    control: bool,
) -> Response {
    let (mut parts, _body) = request.into_parts();
    let Ok(upgrade) = WebSocketUpgrade::from_request_parts(&mut parts, &app).await else {
        return crate::http::unknown_api(Request::from_parts(parts, axum::body::Body::empty()))
            .await;
    };
    let Some((origin, cookie)) = admit(&app, &parts.headers) else {
        return respond::json_response(403, &json::detail("Forbidden"));
    };
    let target = team_protocol::identifiers::canonical_team_id(&json::text(team_id))
        .filter(|_| view_contract::VIEW_ID_RE.is_full(view_id))
        .map(|team| {
            let kind = if control { "control" } else { "stream" };
            format!("/v1/teams/{team}/browser/views/{view_id}/{kind}")
        });
    let bound = Bound {
        app,
        origin,
        cookie,
    };
    upgrade
        .protocols([view_contract::SUBPROTOCOL])
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |page| serve(bound, page, target))
        .into_response()
}

/// `GET /api/teams/{team_id}/browser/views/{view_id}/stream`.
pub async fn stream(
    State(app): State<Arc<App>>,
    Path((team_id, view_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    upgrade(app, request, &team_id, &view_id, false).await
}

/// `GET /api/teams/{team_id}/browser/views/{view_id}/control`.
pub async fn control(
    State(app): State<Arc<App>>,
    Path((team_id, view_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    upgrade(app, request, &team_id, &view_id, true).await
}

async fn close_page(mut page: WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: "".into(),
    };
    let _ = tokio::time::timeout(CLOSE, page.send(Message::Close(Some(frame)))).await;
}

async fn serve(bound: Bound, page: WebSocket, target: Option<String>) {
    let Some(path) = target else {
        return close_page(page, ENDED).await;
    };
    let Ok(_permit) = Arc::clone(&bound.app.domains.team.streams).try_acquire_owned() else {
        return close_page(page, BUSY).await;
    };
    let (code, page) = relay(&bound, page, &path).await;
    if let Some(page) = page {
        close_page(page, code).await;
    }
}

/// Team's side of the stream, or the close code its refusal or failure means for the page.
async fn open_team(bound: &Bound, path: &str) -> Result<TeamSocket, u16> {
    let team = bound
        .app
        .session_team(&bound.cookie)
        .map_err(|_| UNAVAILABLE)?;
    let (connection, headers, uri) = team
        .stream_connection(path)
        .await
        .map_err(|_| UNAVAILABLE)?;
    let mut request = uri.into_client_request().map_err(|_| UNAVAILABLE)?;
    for (name, value) in headers {
        let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::from_bytes(name.as_bytes()),
            axum::http::HeaderValue::from_str(&value),
        ) else {
            return Err(UNAVAILABLE);
        };
        request.headers_mut().insert(name, value);
    }
    request.headers_mut().insert(
        "sec-websocket-protocol",
        axum::http::HeaderValue::from_static(view_contract::SUBPROTOCOL),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let opening = tokio_tungstenite::client_async_with_config(
        request,
        MaybeTlsStream::Plain(connection),
        Some(config),
    );
    match tokio::time::timeout(OPEN, opening).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(tungstenite::Error::Http(response))) => Err(match response.status().as_u16() {
            404 => ENDED,
            _ => UNAVAILABLE,
        }),
        _ => Err(UNAVAILABLE),
    }
}

/// Team's side, opened while the session and Origin are watched and checked once more before the first byte passes.
async fn opened(bound: &Bound, path: &str) -> Result<TeamSocket, u16> {
    let mut team = tokio::select! {
        () = bound.lapsed() => return Err(SIGNED_OUT),
        opened = open_team(bound, path) => opened?,
    };
    if !bound.admitted() {
        let _ = tokio::time::timeout(CLOSE, team.close(None)).await;
        return Err(SIGNED_OUT);
    }
    Ok(team)
}

/// Relays the stream until it ends; the close code for the page, and the page while it is still open.
async fn relay(bound: &Bound, page: WebSocket, path: &str) -> (u16, Option<WebSocket>) {
    let team = match opened(bound, path).await {
        Ok(team) => team,
        Err(code) => return (code, Some(page)),
    };
    let (mut page_sink, mut page_stream) = page.split();
    let (mut team_sink, mut team_stream) = team.split();
    let code = tokio::select! {
        () = bound.lapsed() => SIGNED_OUT,
        code = to_team(&mut page_stream, &mut team_sink) => code,
        code = to_page(&mut team_stream, &mut page_sink) => code,
    };
    let Ok(mut team) = team_sink.reunite(team_stream) else {
        return (code, None);
    };
    let _ = tokio::time::timeout(CLOSE, team.close(None)).await;
    (code, page_sink.reunite(page_stream).ok())
}

/// The page's messages to Team: binary only, within the bound, each sent before its deadline.
async fn to_team(
    page: &mut futures_util::stream::SplitStream<WebSocket>,
    team: &mut futures_util::stream::SplitSink<TeamSocket, tungstenite::Message>,
) -> u16 {
    loop {
        let data = match page.next().await {
            None | Some(Ok(Message::Close(_))) => return FINISHED,
            Some(Ok(Message::Binary(data))) if data.len() <= MAX_MESSAGE_BYTES => data,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(_) => return UNAVAILABLE,
        };
        let sent = tokio::time::timeout(SEND, team.send(tungstenite::Message::Binary(data))).await;
        if !matches!(sent, Ok(Ok(()))) {
            return UNAVAILABLE;
        }
    }
}

/// Team's messages to the page: binary only, each sent before its deadline.
async fn to_page(
    team: &mut futures_util::stream::SplitStream<TeamSocket>,
    page: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> u16 {
    loop {
        let data = match team.next().await {
            None | Some(Ok(tungstenite::Message::Close(_))) => return FINISHED,
            Some(Ok(tungstenite::Message::Binary(data))) => data,
            Some(Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_))) => continue,
            Some(_) => return UNAVAILABLE,
        };
        let sent = tokio::time::timeout(SEND, page.send(Message::Binary(data))).await;
        if !matches!(sent, Ok(Ok(()))) {
            return UNAVAILABLE;
        }
    }
}
