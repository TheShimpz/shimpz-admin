//! One authenticated session socket per browser tab (ADR-0114): `GET /api/session/ws`, `shimpz.admin.v1`.
//!
//! The socket is admitted exactly as Admin's own page is: one canonical admitted Origin, Fetch Metadata that says the
//! page itself opened it, the exact subprotocol, and a current Supervisor session. It stays bound to that Origin and
//! session. Before every frame it acts on, and again when a waiting call's turn to run comes, Admin checks that the
//! Origin is still admitted and the session still current, and closes the socket when either is not (4403, 4401).
//! None of that renews the session: only the page's activity frame does. The receive loop never waits for a call or a
//! write.

use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{
        Request, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::watch;
use zeroize::Zeroizing;

use super::{
    frames::{self, ProtocolError},
    outbound::{Outbound, Refused},
    registry::SIGNED_OUT,
};
use crate::{
    app::{App, COOKIE},
    authority::{Authority, SessionStatus, session_status},
    fault::Reply,
    http::browser,
    json::{self, Value},
    signin::{sessions::session_key, tickets::Binding, token},
    sync::lock,
};

/// The bound Origin is no longer admitted.
pub const ORIGIN_REFUSED: u16 = 4403;
/// The subprotocol is not this protocol.
pub const PROTOCOL_REFUSED: u16 = 4406;
/// Admin cannot serve the socket now.
pub const UNAVAILABLE: u16 = 1013;
/// A margin past a session's expiry before its timer checks it.
const EXPIRY_MARGIN_MS: i64 = 50;
/// The longest a quiet socket goes without checking its Origin and session again.
const SESSION_CHECK_MS: i64 = 60_000;
/// The largest message the transport reads at all; a larger admitted-size violation still closes with 1009.
const TRANSPORT_MESSAGE_BYTES: usize = 4 * frames::MAX_INBOUND_BYTES;

/// One Team's chat on a socket (`chat.attach`): its frames go to the Team's run, its events come back.
pub trait Channel: Send + Sync {
    /// After the attach result: where the Team's running chat is, or today's sync when nothing runs.
    fn start(&self);
    /// One admitted chat frame; `false` when too many frames are already waiting.
    fn submit(&self, frame: Value) -> bool;
    /// The page stops watching; the Team's work goes on (ADR-0119).
    fn leave(&self);
}

/// Why a frame could not be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The frame exceeds the frame bound.
    Oversized,
    /// The socket closed, or closed now because its queue overflowed.
    Closed,
}

/// One admitted socket.
pub struct Socket {
    app: Arc<App>,
    origin: String,
    cookie: Arc<Zeroizing<String>>,
    session: String,
    step_up: Binding,
    ticket: Mutex<Zeroizing<String>>,
    outbound: Outbound,
    closed: watch::Sender<Option<u16>>,
    subscriptions: Mutex<BTreeSet<String>>,
    channels: Mutex<HashMap<String, Arc<dyn Channel>>>,
    calls: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Socket {
    fn new(app: Arc<App>, origin: String, cookie: String) -> Self {
        let session = session_key(&cookie);
        Self {
            step_up: Binding {
                session: session.clone(),
                socket: crate::random::hex(16),
            },
            app,
            origin,
            cookie: Arc::new(Zeroizing::new(cookie)),
            session,
            ticket: Mutex::new(Zeroizing::new(String::new())),
            outbound: Outbound::new(frames::MAX_QUEUED_BYTES),
            closed: watch::Sender::new(None),
            subscriptions: Mutex::new(BTreeSet::new()),
            channels: Mutex::new(HashMap::new()),
            calls: Mutex::new(HashMap::new()),
        }
    }

    /// The process.
    #[must_use]
    pub const fn app(&self) -> &Arc<App> {
        &self.app
    }

    /// The Origin the socket is bound to.
    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// The session cookie the socket opened with.
    #[must_use]
    pub fn cookie(&self) -> &str {
        &self.cookie
    }

    /// The session's digest.
    #[must_use]
    pub fn session(&self) -> &str {
        &self.session
    }

    /// The socket and session a step-up ticket issued over this socket is bound to.
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.step_up
    }

    /// The authority work admitted on this socket keeps after the socket closes (chat, sign-in sessions).
    #[must_use]
    pub fn authority(&self) -> Authority {
        Authority::new(&self.app, &self.cookie, &self.origin)
    }

    /// Replaces the one-use ticket of the confirmed operation last begun over this socket, returning the earlier one.
    pub fn replace_ticket(&self, token: String) -> Zeroizing<String> {
        std::mem::replace(&mut *lock(&self.ticket), Zeroizing::new(token))
    }

    /// Takes the socket's pending ticket, leaving none.
    pub fn take_ticket(&self) -> Zeroizing<String> {
        self.replace_ticket(String::new())
    }

    /// Whether this socket is still registered in its session.
    #[must_use]
    pub fn live(&self) -> bool {
        self.app.domains.session.registry.live(&self.step_up)
    }

    // Lifetime

    /// Closes the socket with `code`; the first close wins.
    pub fn end(&self, code: u16) {
        self.closed.send_if_modified(|closed| {
            if closed.is_some() {
                return false;
            }
            *closed = Some(code);
            true
        });
        self.outbound.close();
    }

    /// Whether the socket closed.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    fn close_code(&self) -> u16 {
        self.closed.borrow().unwrap_or(1000)
    }

    /// Waits until the socket closes.
    pub async fn wait_closed(&self) {
        let mut receiver = self.closed.subscribe();
        let _ = receiver.wait_for(Option::is_some).await;
    }

    // Outbound

    /// Queues one server frame; an overflowing queue closes the socket and the client re-reads.
    ///
    /// # Errors
    ///
    /// Returns [`SendError`] when the frame is too large or the socket closed.
    pub fn send(&self, frame: &Value, topic: Option<&str>) -> Result<(), SendError> {
        let text = frames::encode(frame).map_err(|_| SendError::Oversized)?;
        match self.outbound.put(text, topic) {
            Ok(()) => Ok(()),
            Err(Refused::Closed) => Err(SendError::Closed),
            Err(Refused::Overflow) => {
                crate::command::log("warning", "session_outbound_overflow");
                self.end(UNAVAILABLE);
                Err(SendError::Closed)
            }
        }
    }

    /// Sends one chat event on a Team's channel.
    ///
    /// # Errors
    ///
    /// Returns [`SendError`] as [`Self::send`] does; an event naming another Team is never sent.
    pub fn send_chat(&self, team_id: &str, event: &Value) -> Result<(), SendError> {
        let frame = frames::chat_event(team_id, event).ok_or(SendError::Oversized)?;
        self.send(&frame, None)
    }

    /// A long call started running: its result follows when it ends.
    pub fn progress(&self, call_id: &str) {
        if lock(&self.calls).contains_key(call_id) && !self.is_closed() {
            let _ = self.send(&frames::progress(call_id), None);
        }
    }

    fn changed(&self, topic: &str, revision: u64) {
        if lock(&self.subscriptions).contains(topic) && !self.is_closed() {
            let frame = frames::changed(topic, &self.app.topics.epoch, revision);
            let _ = self.send(&frame, Some(topic));
        }
    }

    fn deadlines(&self) -> Option<(i64, i64)> {
        let secret = self.app.store.session_secret().ok()?;
        token::deadlines(&self.app.sessions, &self.app.clock, &secret, &self.cookie)
    }

    /// The session's idle time restarted: tell the page its new deadlines.
    pub fn send_deadlines(&self) {
        if self.is_closed() {
            return;
        }
        if let Some((idle, absolute)) = self.deadlines() {
            let frame = frames::session(idle / 1000, absolute / 1000, self.app.source.as_ref());
            let _ = self.send(&frame, None);
        }
    }

    // Checks

    fn status(&self) -> Result<(), u16> {
        let Ok(origins) = self.app.allowed_origins() else {
            return Err(UNAVAILABLE);
        };
        if !origins.contains(&self.origin) {
            return Err(ORIGIN_REFUSED);
        }
        match session_status(&self.app, &self.cookie, false) {
            SessionStatus::Active => Ok(()),
            refused => Err(refusal(refused)),
        }
    }

    /// The socket is open and its Origin and session are still current, or it closes now; never renewing the session.
    #[must_use]
    pub fn authorized(&self) -> bool {
        if self.is_closed() {
            return false;
        }
        match self.status() {
            Ok(()) => true,
            Err(code) => {
                self.end(code);
                false
            }
        }
    }

    // Subscriptions and chat channels

    /// Whether the socket subscribes to `topic`.
    #[must_use]
    pub fn subscribed(&self, topic: &str) -> bool {
        lock(&self.subscriptions).contains(topic)
    }

    fn subscription(&self, subscriptions: &BTreeSet<String>) -> Value {
        let revisions = subscriptions
            .iter()
            .map(|topic| {
                let revision = self.app.topics.revision(topic);
                (
                    topic.clone(),
                    json::int(i64::try_from(revision).unwrap_or(i64::MAX)),
                )
            })
            .collect();
        json::object(vec![
            ("epoch", json::text(&self.app.topics.epoch)),
            ("topics", Value::Object(revisions)),
        ])
    }

    /// Subscribes to `topics`: their current revisions, or 409 past the bound.
    #[must_use]
    pub fn subscribe(&self, topics: &[String]) -> Reply {
        let mut subscriptions = lock(&self.subscriptions);
        let mut wanted = subscriptions.clone();
        wanted.extend(topics.iter().cloned());
        if wanted.len() > frames::MAX_SUBSCRIPTIONS {
            return Reply::detail(409, "a session socket subscribes to at most 64 topics");
        }
        *subscriptions = wanted;
        let reply = Reply::ok(self.subscription(&subscriptions));
        drop(subscriptions);
        reply
    }

    /// Unsubscribes from `topics`.
    #[must_use]
    pub fn unsubscribe(&self, topics: &[String]) -> Reply {
        let mut subscriptions = lock(&self.subscriptions);
        for topic in topics {
            subscriptions.remove(topic);
        }
        let reply = Reply::ok(self.subscription(&subscriptions));
        drop(subscriptions);
        reply
    }

    /// Makes the socket a chat connection for one more Team; its channel starts after the result is queued.
    #[must_use]
    pub fn attach(self: &Arc<Self>, team_id: &Value, locale: &Value) -> Reply {
        if !frames::is_team_id(team_id) {
            return Reply::detail(400, "Team id is invalid");
        }
        let Some(locale) = team_protocol::payload::canonical_locale(locale) else {
            return Reply::detail(400, "locale is invalid");
        };
        let team_id = json::as_str(team_id).unwrap_or_default().to_owned();
        let mut channels = lock(&self.channels);
        if channels.contains_key(&team_id) {
            return Reply::detail(409, "the Team's chat is already attached");
        }
        if channels.len() >= frames::MAX_ATTACHED_TEAMS {
            return Reply::detail(409, "a session socket attaches at most 4 Teams");
        }
        let channel = crate::chat::run::channel(self, &team_id, locale);
        channels.insert(team_id.clone(), channel);
        drop(channels);
        Reply::ok(json::object(vec![("team_id", json::text(team_id))]))
    }

    /// Starts the channel `attach` just added, once its result is queued.
    pub fn start_channel(&self, team_id: &str) {
        let channel = lock(&self.channels).get(team_id).cloned();
        if let Some(channel) = channel {
            channel.start();
        }
    }

    /// Stops watching one Team's chat; its work goes on.
    #[must_use]
    pub fn detach(&self, team_id: &Value) -> Reply {
        let channel =
            json::as_str(team_id).and_then(|team_id| lock(&self.channels).remove(team_id));
        let Some(channel) = channel else {
            return Reply::detail(409, "the Team's chat is not attached");
        };
        channel.leave();
        Reply::ok(json::object(vec![("team_id", team_id.clone())]))
    }

    // Inbound

    fn frame(self: &Arc<Self>, frame: &Value) -> Result<(), ProtocolError> {
        match json::get_str(frame, "type") {
            Some("call") => self.call(frame),
            Some("activity") => {
                frames::activity(frame)?;
                self.activity();
                Ok(())
            }
            Some(kind) if frames::CHAT_TYPES.contains(&kind) => self.chat(frame),
            _ => Err(ProtocolError("unsupported session frame")),
        }
    }

    fn call(self: &Arc<Self>, frame: &Value) -> Result<(), ProtocolError> {
        let call = frames::call(frame)?;
        if lock(&self.calls).contains_key(&call.id) {
            return Err(ProtocolError("duplicate call id"));
        }
        if !self.authorized() {
            return Ok(());
        }
        let mut refused = super::calls::admission(self, call.method);
        if refused.is_none() && lock(&self.calls).len() >= frames::MAX_IN_FLIGHT {
            refused = Some("too many calls in flight");
        }
        if let Some(reason) = refused {
            let _ = self.send(
                &frames::result(&call.id, 429, json::detail(reason), None),
                None,
            );
            return Ok(());
        }
        let mut calls = lock(&self.calls);
        let socket = Arc::clone(self);
        let id = call.id.clone();
        let task = tokio::spawn(async move {
            let id = call.id.clone();
            super::calls::run(&socket, call).await;
            lock(&socket.calls).remove(&id);
        });
        calls.insert(id, task.abort_handle());
        drop(calls);
        Ok(())
    }

    fn chat(&self, frame: &Value) -> Result<(), ProtocolError> {
        let (team_id, chat) = frames::chat_frame(frame)?;
        let channel = lock(&self.channels)
            .get(&team_id)
            .cloned()
            .ok_or(ProtocolError("chat channel is not attached"))?;
        if !self.authorized() {
            return Ok(());
        }
        let stop = json::equal(&chat, &json::object(vec![("type", json::text("stop"))]));
        if !stop && !self.app.domains.session.budgets.calls.admit(&self.session) {
            let terminal =
                crate::chat::projection::error_terminal(429, "session call budget reached");
            let _ = self.send_chat(&team_id, &terminal);
            return Ok(());
        }
        if channel.submit(chat) {
            Ok(())
        } else {
            Err(ProtocolError("too many chat frames are waiting"))
        }
    }

    /// The person's own input restarts the session's idle time, at most once per renewal interval per session.
    fn activity(&self) {
        let budgets = &self.app.domains.session.budgets;
        if !self.authorized()
            || !budgets.calls.admit(&self.session)
            || !budgets.renewals.due(&self.session)
        {
            return;
        }
        match session_status(&self.app, &self.cookie, true) {
            SessionStatus::Active => self.app.domains.session.registry.renewed(&self.session),
            refused => self.end(refusal(refused)),
        }
    }

    /// Ends the socket's authority at once, leaves each chat channel, and stops its calls.
    fn shut_down(&self) {
        let domain = &self.app.domains.session;
        domain.registry.remove(self);
        self.app.tickets.revoke(&self.step_up);
        let ticket = self.take_ticket();
        crate::signin::local::discard_operation(&self.app, &ticket);
        for (_, call) in lock(&self.calls).drain() {
            call.abort();
        }
        let channels: Vec<Arc<dyn Channel>> = lock(&self.channels)
            .drain()
            .map(|(_, channel)| channel)
            .collect();
        for channel in channels {
            channel.leave();
        }
        domain.watcher.refresh(&self.app);
    }
}

const fn refusal(status: SessionStatus) -> u16 {
    match status {
        SessionStatus::Unavailable => UNAVAILABLE,
        _ => SIGNED_OUT,
    }
}

/// The handshake's one exact admitted Origin, under the HTTP gate's own page check.
fn admitted_origin(headers: &HeaderMap, origins: &[String]) -> Option<String> {
    let mut sent = headers.get_all("origin").iter();
    let origin = sent.next()?.to_str().ok()?.to_owned();
    if sent.next().is_some() || !browser::from_admin_page(headers, origins) {
        return None;
    }
    Some(origin)
}

/// The subprotocols the handshake offers, as the server reads them.
fn offered_protocols(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|protocol| protocol.trim().to_owned())
        .filter(|protocol| !protocol.is_empty())
        .collect()
}

/// Admits the handshake as the bound Origin and session cookie, or the close code that refuses it before accepting.
fn admit(app: &App, headers: &HeaderMap) -> Result<(String, String), u16> {
    let Ok(origins) = app.allowed_origins() else {
        crate::command::log("error", "session_origin_authority_unavailable");
        return Err(UNAVAILABLE);
    };
    let origin = admitted_origin(headers, &origins).ok_or(ORIGIN_REFUSED)?;
    if offered_protocols(headers) != [frames::SUBPROTOCOL] {
        return Err(PROTOCOL_REFUSED);
    }
    let cookie = browser::cookie(headers, COOKIE).unwrap_or_default();
    match session_status(app, &cookie, false) {
        SessionStatus::Active => {}
        refused => return Err(refusal(refused)),
    }
    if !app
        .domains
        .session
        .budgets
        .opens
        .admit(&session_key(&cookie))
    {
        return Err(UNAVAILABLE);
    }
    Ok((origin, cookie))
}

/// A socket refused before it was accepted: the HTTP 403 a server answers a handshake it closes.
fn refused_handshake() -> Response {
    crate::http::respond::json_response(403, &json::detail("Forbidden"))
}

/// `GET /api/session/ws`.
pub async fn upgrade(State(app): State<Arc<App>>, request: Request) -> Response {
    let (mut parts, _body) = request.into_parts();
    let Ok(upgrade) =
        <WebSocketUpgrade as axum::extract::FromRequestParts<Arc<App>>>::from_request_parts(
            &mut parts, &app,
        )
        .await
    else {
        return crate::http::unknown_api(Request::from_parts(parts, axum::body::Body::empty()))
            .await;
    };
    let Ok((origin, cookie)) = admit(&app, &parts.headers) else {
        return refused_handshake();
    };
    let socket = Arc::new(Socket::new(Arc::clone(&app), origin, cookie));
    if !app.domains.session.registry.add(&socket) {
        return refused_handshake();
    }
    upgrade
        .protocols([frames::SUBPROTOCOL])
        .max_message_size(TRANSPORT_MESSAGE_BYTES)
        .on_failed_upgrade({
            let socket = Arc::clone(&socket);
            move |_| socket.app.domains.session.registry.remove(&socket)
        })
        .on_upgrade(move |websocket| serve(socket, websocket))
        .into_response()
}

/// The next client frame's admitted object, or why the socket closes.
fn decode(message: Message) -> Result<Option<Value>, u16> {
    let fields = match message {
        Message::Text(text) => vec![
            ("type".to_owned(), json::text("websocket.receive")),
            ("text".to_owned(), json::text(text.as_str())),
        ],
        Message::Binary(_) => vec![
            ("type".to_owned(), json::text("websocket.receive")),
            ("bytes".to_owned(), json::text("")),
        ],
        Message::Ping(_) | Message::Pong(_) => return Ok(None),
        Message::Close(_) => return Err(1000),
    };
    let max = i64::try_from(frames::MAX_INBOUND_BYTES).unwrap_or(i64::MAX);
    team_protocol::websocket::decode_bounded_json_frame(&fields, max)
        .map(Some)
        .map_err(|error| error.close_code)
}

async fn read(socket: &Arc<Socket>, mut receiver: futures_util::stream::SplitStream<WebSocket>) {
    let mut closed = socket.closed.subscribe();
    loop {
        let message = tokio::select! {
            message = receiver.next() => message,
            _ = closed.wait_for(Option::is_some) => return,
        };
        let code = match message {
            None => 1000,
            Some(Err(error)) => transport_close(&error),
            Some(Ok(message)) => match decode(message) {
                Ok(None) => continue,
                Ok(Some(frame)) => match socket.frame(&frame) {
                    Ok(()) => continue,
                    Err(_) => ProtocolError::CLOSE_CODE,
                },
                Err(code) => code,
            },
        };
        socket.end(code);
        return;
    }
}

fn transport_close(error: &axum::Error) -> u16 {
    let capacity = std::error::Error::source(error)
        .and_then(|source| source.downcast_ref::<tokio_tungstenite::tungstenite::Error>())
        .is_some_and(|error| matches!(error, tokio_tungstenite::tungstenite::Error::Capacity(_)));
    if capacity { 1009 } else { 1000 }
}

async fn write(
    socket: Arc<Socket>,
    mut sender: futures_util::stream::SplitSink<WebSocket, Message>,
) {
    let mut closed = socket.closed.subscribe();
    loop {
        let text = tokio::select! {
            text = socket.outbound.take() => text,
            _ = closed.wait_for(Option::is_some) => break,
        };
        if sender.send(Message::Text(text.into())).await.is_err() {
            socket.end(1000);
            break;
        }
    }
    let close = CloseFrame {
        code: socket.close_code(),
        reason: "".into(),
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        sender.send(Message::Close(Some(close))),
    )
    .await;
}

/// Closes the socket at its session's absolute or idle expiry, checking its Origin and session at least each minute.
async fn expire(socket: Arc<Socket>) {
    let mut closed = socket.closed.subscribe();
    while !socket.is_closed() {
        let wait = socket.deadlines().map_or(0, |(idle, absolute)| {
            (idle.min(absolute) + EXPIRY_MARGIN_MS).min(SESSION_CHECK_MS)
        });
        let pause = Duration::from_millis(u64::try_from(wait).unwrap_or(0));
        tokio::select! {
            () = tokio::time::sleep(pause) => {}
            _ = closed.wait_for(Option::is_some) => return,
        }
        if !socket.authorized() {
            return;
        }
    }
}

async fn serve(socket: Arc<Socket>, websocket: WebSocket) {
    let (sender, receiver) = websocket.split();
    socket.send_deadlines();
    let listener = {
        let weak = Arc::downgrade(&socket);
        socket.app.topics.listen(Arc::new(move |topic, revision| {
            if let Some(socket) = weak.upgrade() {
                socket.changed(topic, revision);
            }
        }))
    };
    let writer = tokio::spawn(write(Arc::clone(&socket), sender));
    let expiry = tokio::spawn(expire(Arc::clone(&socket)));
    read(&socket, receiver).await;
    socket.app.topics.forget(listener);
    socket.end(socket.close_code());
    socket.shut_down();
    expiry.abort();
    let _ = writer.await;
}

#[cfg(test)]
mod tests;
