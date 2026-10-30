//! The Admin session socket protocol `shimpz.admin.v1` (ADR-0114): closed frames, bounds, methods, and topics.
//!
//! Admin owns this protocol and is its only server; this module is both its reference validator and the one Admin
//! runs. Every frame is one UTF-8 JSON object with unique keys in a text frame. A client frame is at most 128 KiB; a
//! server frame, envelope included, at most 1 MiB. `protocol/socket/v1/vectors.json` holds its golden frames, which
//! the browser's unit tests replay too.

use std::sync::LazyLock;

use team_protocol::{
    identifiers::canonical_team_id,
    python::regex::{Pattern, declared},
};

use crate::json::{self, Value};

/// The subprotocol a page asks for.
pub const SUBPROTOCOL: &str = "shimpz.admin.v1";
/// The socket's path.
pub const PATH: &str = "/api/session/ws";
/// The largest client frame.
pub const MAX_INBOUND_BYTES: usize = 128 * 1024;
/// The largest server frame, its envelope included.
pub const MAX_OUTBOUND_BYTES: usize = 1024 * 1024;
/// The most bytes waiting to be written to one socket.
pub const MAX_QUEUED_BYTES: usize = 1024 * 1024;
/// The most calls one socket has in flight.
pub const MAX_IN_FLIGHT: usize = 16;
/// The most topics one socket subscribes to.
pub const MAX_SUBSCRIPTIONS: usize = 64;
/// The most Teams' chats one socket watches.
pub const MAX_ATTACHED_TEAMS: usize = 4;
/// The most sockets one session holds open.
pub const MAX_SOCKETS_PER_SESSION: usize = 8;
/// The latest commit time (UTC seconds) a version name can show.
pub const MAX_SOURCE_TIME: i64 = 253_402_300_799;
/// The longest call parameter.
pub const MAX_PARAM_CHARS: usize = 128;
const KIB: usize = 1024;

static CALL_ID_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[A-Za-z0-9_-]{1,64}\Z"));
/// A process epoch.
pub static EPOCH_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{32}\Z"));
static SOURCE_REVISION_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{40}\Z"));
static TOPIC_RE: LazyLock<Pattern> = LazyLock::new(|| {
    declared(concat!(
        r"(?:teams|space/(?:models|decision|chat-limit)|platform/release|security/summary|session|assistants/registry",
        r"|local-assistants",
        r"|team/[a-z0-9_]{1,40}/(?:routines|history|inventory|inference|integrations|sign-in))\Z"
    ))
});

/// Each method, its required parameters, and its optional ones. Every parameter is a string of at most 128
/// characters, except `topics` and a request `body`, which is one JSON object.
pub const METHODS: &[(&str, &[&str], &[&str])] = &[
    ("teams.list", &[], &[]),
    ("teams.create", &["body"], &[]),
    ("teams.rename", &["team_id", "body"], &[]),
    ("teams.reorder", &["body"], &[]),
    ("teams.delete", &["team_id", "body"], &[]),
    ("history.page", &["team_id"], &["before", "routine"]),
    ("routines.list", &["team_id"], &[]),
    ("platform.release", &[], &[]),
    ("security.summary", &[], &[]),
    ("inference.read", &["team_id"], &[]),
    ("inference.save", &["team_id", "body"], &[]),
    ("assistants.registry", &[], &[]),
    ("assistants.list", &["team_id"], &[]),
    ("assistants.install", &["team_id", "body"], &[]),
    ("assistants.install_local", &["team_id", "body"], &[]),
    ("assistants.uninstall", &["team_id", "assistant_id"], &[]),
    (
        "assistants.summary",
        &["team_id", "assistant_id", "locale"],
        &[],
    ),
    (
        "assistants.details",
        &["team_id", "assistant_id", "locale"],
        &[],
    ),
    ("snapshots.list", &[], &[]),
    ("snapshots.summary", &["image_id", "locale"], &[]),
    ("snapshots.details", &["image_id", "locale"], &[]),
    ("models.list", &[], &[]),
    ("models.save", &["provider", "body"], &[]),
    ("decision.read", &[], &[]),
    ("decision.save", &["body"], &[]),
    ("decision.remove", &[], &[]),
    ("chat_limit.read", &[], &[]),
    ("chat_limit.save", &["body"], &[]),
    ("integrations.list", &["team_id"], &[]),
    (
        "integrations.authorize",
        &["team_id", "challenge_id", "body"],
        &[],
    ),
    (
        "integrations.complete",
        &["team_id", "challenge_id", "body"],
        &[],
    ),
    ("integrations.cancel", &["team_id", "challenge_id"], &[]),
    ("stored_inputs.list", &["team_id"], &[]),
    (
        "stored_inputs.clear",
        &["team_id", "assistant_id", "stored_input_id"],
        &[],
    ),
    ("files.acknowledge", &["team_id", "file_id"], &[]),
    ("browser.view", &["team_id"], &[]),
    ("sign_in.start", &["team_id", "body"], &[]),
    ("sign_in.save", &["team_id", "body"], &[]),
    ("sign_in.cancel", &["team_id", "body"], &[]),
    ("sign_in.read", &["team_id"], &[]),
    ("sign_in.deletion", &["team_id", "body"], &[]),
    (
        "sign_in.delete",
        &[
            "team_id",
            "sign_in_id",
            "generation",
            "team_incarnation",
            "body",
        ],
        &[],
    ),
    ("store.catalog", &["locale"], &["cursor"]),
    ("routines.pause", &["team_id", "routine_id"], &[]),
    ("routines.resume", &["team_id", "routine_id"], &[]),
    ("routines.deletion", &["team_id", "routine_id", "body"], &[]),
    ("routines.delete", &["team_id", "routine_id", "body"], &[]),
    (
        "routines.plan_steps",
        &["team_id", "routine_id", "revision", "offset"],
        &[],
    ),
    (
        "routines.run_steps",
        &["team_id", "run_id", "snapshot", "offset"],
        &[],
    ),
    ("routines.diagnostics", &["team_id", "run_id"], &[]),
    ("routines.card", &["team_id", "run_id"], &[]),
    ("routines.card_answer", &["team_id", "run_id", "body"], &[]),
    ("routines.challenge", &["team_id", "run_id", "body"], &[]),
    ("routines.human", &["team_id", "run_id", "body"], &[]),
    ("routines.integrations", &["team_id", "run_id"], &[]),
    (
        "routines.proposal_confirm",
        &["team_id", "proposal_id"],
        &[],
    ),
    ("routines.proposal_revoke", &["team_id", "proposal_id"], &[]),
    ("security.acknowledge", &["body"], &[]),
    ("recovery_codes.confirmation", &["body"], &[]),
    ("recovery_codes.replace", &["body"], &[]),
    ("supervisor_key.confirmation", &["body"], &[]),
    ("supervisor_key.rotate", &["body"], &[]),
    ("subscribe", &["topics"], &[]),
    ("unsubscribe", &["topics"], &[]),
    ("chat.attach", &["team_id", "locale"], &[]),
    ("chat.detach", &["team_id"], &[]),
];

/// The most bytes each method's request body takes as compact UTF-8 JSON: the bound its operation always had. A larger
/// body is answered 413.
pub const BODY_BYTES: &[(&str, usize)] = &[
    ("teams.create", KIB),
    ("teams.rename", KIB),
    ("teams.reorder", 8 * KIB),
    ("teams.delete", 8 * KIB),
    ("inference.save", 16 * KIB),
    ("assistants.install", 16 * KIB),
    ("assistants.install_local", 16 * KIB),
    ("models.save", 16 * KIB),
    ("decision.save", 16 * KIB),
    ("chat_limit.save", KIB),
    ("integrations.authorize", 16 * KIB),
    ("integrations.complete", 16 * KIB),
    ("routines.deletion", 8 * KIB),
    ("routines.delete", 16 * KIB),
    ("routines.card_answer", 16 * KIB),
    ("routines.challenge", 16 * KIB),
    ("routines.human", 96 * KIB),
    ("security.acknowledge", KIB),
    ("sign_in.start", 16 * KIB),
    ("sign_in.save", KIB),
    ("sign_in.cancel", KIB),
    ("sign_in.deletion", 8 * KIB),
    ("sign_in.delete", 16 * KIB),
    ("recovery_codes.confirmation", 8 * KIB),
    ("recovery_codes.replace", 8 * KIB),
    ("supervisor_key.confirmation", 8 * KIB),
    ("supervisor_key.rotate", 8 * KIB),
];

/// The long calls: each keeps its result pending while it runs and says once, with `progress`, that it started.
pub const LONG_METHODS: &[&str] = &[
    "assistants.install",
    "assistants.install_local",
    "routines.human",
    "routines.integrations",
];

/// Calls that change only what the socket itself holds; they count against the socket-change budget and run without
/// any authority scope.
pub const SOCKET_STATE_METHODS: &[&str] =
    &["subscribe", "unsubscribe", "chat.attach", "chat.detach"];

/// The `shimpz.chat.v7` frames a client sends on an attached Team's chat channel.
pub const CHAT_TYPES: &[&str] = &["chat", "resume-task", "stop", "sync", "human-response"];

/// A client frame outside this protocol; it closes the socket with policy violation (1008).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub &'static str);

impl ProtocolError {
    /// The close code.
    pub const CLOSE_CODE: u16 = 1008;
}

/// A server frame larger than the outbound bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OversizedFrame;

/// The shape of `method`: its required and optional parameters.
#[must_use]
pub fn shape(method: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    METHODS
        .iter()
        .find(|(name, _, _)| *name == method)
        .map(|(_, required, optional)| (*required, *optional))
}

/// The body bound of `method`, if it takes a body.
#[must_use]
pub fn body_limit(method: &str) -> Option<usize> {
    BODY_BYTES
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, limit)| *limit)
}

/// Whether `method` is a long call.
#[must_use]
pub fn is_long(method: &str) -> bool {
    LONG_METHODS.contains(&method)
}

/// Whether `method` changes only what the socket holds.
#[must_use]
pub fn is_socket_state(method: &str) -> bool {
    SOCKET_STATE_METHODS.contains(&method)
}

/// The topic a read's result reflects, for the reads a topic's change asks the client to repeat.
#[must_use]
pub fn read_topic(method: &str, params: &Value) -> Option<String> {
    let team = |name: &str| {
        json::get_str(params, "team_id").map(|team_id| format!("team/{team_id}/{name}"))
    };
    match method {
        "teams.list" => Some("teams".to_owned()),
        "history.page" => team("history"),
        "routines.list" => team("routines"),
        "platform.release" => Some("platform/release".to_owned()),
        "security.summary" => Some("security/summary".to_owned()),
        "inference.read" => team("inference"),
        "assistants.registry" => Some("assistants/registry".to_owned()),
        "assistants.list" | "assistants.summary" | "assistants.details" => team("inventory"),
        "snapshots.list" | "snapshots.summary" | "snapshots.details" => {
            Some("local-assistants".to_owned())
        }
        "models.list" => Some("space/models".to_owned()),
        "decision.read" => Some("space/decision".to_owned()),
        "chat_limit.read" => Some("space/chat-limit".to_owned()),
        "integrations.list" | "stored_inputs.list" => team("integrations"),
        "sign_in.read" => team("sign-in"),
        _ => None,
    }
}

/// Whether `method` is a read that names a topic.
#[must_use]
pub fn is_read(method: &str) -> bool {
    read_topic(method, &json::object(vec![("team_id", json::text("x"))])).is_some()
}

/// A call id.
#[must_use]
pub fn is_call_id(value: &Value) -> bool {
    CALL_ID_RE.is_full_value(value)
}

/// A topic of this version.
#[must_use]
pub fn is_topic(value: &str) -> bool {
    TOPIC_RE.is_full(value)
}

/// A canonical Team id.
#[must_use]
pub fn is_team_id(value: &Value) -> bool {
    canonical_team_id(value).is_some()
}

fn param(value: &Value) -> bool {
    json::as_str(value)
        .is_some_and(|text| team_protocol::python::text::len(text) <= MAX_PARAM_CHARS)
}

/// The exact unique topics a subscription change names: one to 64.
///
/// # Errors
///
/// Returns [`ProtocolError`] for any other `topics`.
pub fn topics(params: &Value) -> Result<Vec<String>, ProtocolError> {
    let refused = ProtocolError("invalid session topics");
    let items = json::get(params, "topics")
        .and_then(json::as_array)
        .ok_or(refused)?;
    if items.is_empty() || items.len() > MAX_SUBSCRIPTIONS {
        return Err(refused);
    }
    let mut named: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let topic = json::as_str(item)
            .filter(|topic| is_topic(topic))
            .ok_or(refused)?;
        if named.iter().any(|seen| seen == topic) {
            return Err(refused);
        }
        named.push(topic.to_owned());
    }
    Ok(named)
}

/// One admitted call: its id, method, and params.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    /// The call id.
    pub id: String,
    /// The method.
    pub method: &'static str,
    /// The params object.
    pub params: Value,
}

/// Admits one call frame as its id, method, and params.
///
/// # Errors
///
/// Returns [`ProtocolError`] for a frame outside the protocol.
pub fn call(frame: &Value) -> Result<Call, ProtocolError> {
    if !json::has_exactly(frame, &["type", "id", "method", "params"]) {
        return Err(ProtocolError("invalid call frame"));
    }
    let id = json::get(frame, "id").filter(|value| is_call_id(value));
    let params = json::get(frame, "params").filter(|value| json::members(value).is_some());
    let (Some(id), Some(params)) = (id, params) else {
        return Err(ProtocolError("invalid call frame"));
    };
    let method = json::get_str(frame, "method")
        .and_then(|name| METHODS.iter().find(|(known, _, _)| *known == name))
        .map(|(name, _, _)| *name)
        .ok_or(ProtocolError("unknown session method"))?;
    let (required, optional) = shape(method).ok_or(ProtocolError("unknown session method"))?;
    let names: Vec<&str> = json::members(params)
        .unwrap_or_default()
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    if !required.iter().all(|name| names.contains(name))
        || !names
            .iter()
            .all(|name| required.contains(name) || optional.contains(name))
    {
        return Err(ProtocolError("invalid call parameters"));
    }
    if matches!(method, "subscribe" | "unsubscribe") {
        topics(params)?;
    } else if !json::members(params)
        .unwrap_or_default()
        .iter()
        .all(|(name, value)| {
            if name == "body" {
                json::members(value).is_some()
            } else {
                param(value)
            }
        })
    {
        return Err(ProtocolError("invalid call parameters"));
    }
    Ok(Call {
        id: json::as_str(id).unwrap_or_default().to_owned(),
        method,
        params: params.clone(),
    })
}

/// A request body's size as the page sends it: compact JSON in UTF-8.
#[must_use]
pub fn body_bytes(body: &Value) -> usize {
    json::compact_len(body)
}

/// Admits the person's activity frame, which carries nothing else.
///
/// # Errors
///
/// Returns [`ProtocolError`] for any other frame.
pub fn activity(frame: &Value) -> Result<(), ProtocolError> {
    if json::has_exactly(frame, &["type"]) && json::get_str(frame, "type") == Some("activity") {
        Ok(())
    } else {
        Err(ProtocolError("invalid activity frame"))
    }
}

/// Splits one chat-channel frame into its Team and the `shimpz.chat.v7` frame it carries.
///
/// # Errors
///
/// Returns [`ProtocolError`] for a frame of another type or without a canonical Team id.
pub fn chat_frame(frame: &Value) -> Result<(String, Value), ProtocolError> {
    let kind = json::get_str(frame, "type");
    let team_id = json::get(frame, "team_id").filter(|value| is_team_id(value));
    match (kind, team_id) {
        (Some(kind), Some(team_id)) if CHAT_TYPES.contains(&kind) => Ok((
            json::as_str(team_id).unwrap_or_default().to_owned(),
            json::without(frame, "team_id"),
        )),
        _ => Err(ProtocolError("invalid chat channel frame")),
    }
}

/// Serializes one server frame.
///
/// # Errors
///
/// Returns [`OversizedFrame`] for a frame beyond the outbound bound.
pub fn encode(frame: &Value) -> Result<String, OversizedFrame> {
    let text = json::compact(frame);
    if text.len() > MAX_OUTBOUND_BYTES {
        return Err(OversizedFrame);
    }
    Ok(text)
}

/// The topic, process epoch, and topic revision a read's result reflects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
    /// The topic.
    pub topic: String,
    /// The process epoch.
    pub epoch: String,
    /// The topic's revision, taken before the read.
    pub revision: u64,
}

/// One call's result.
#[must_use]
pub fn result(call_id: &str, status: u16, body: Value, revision: Option<&Revision>) -> Value {
    let mut members = vec![
        ("type", json::text("result")),
        ("id", json::text(call_id)),
        ("status", json::int(i64::from(status))),
        ("body", body),
    ];
    if let Some(revision) = revision {
        members.push(("topic", json::text(&revision.topic)));
        members.push(("epoch", json::text(&revision.epoch)));
        members.push((
            "revision",
            json::int(i64::try_from(revision.revision).unwrap_or(i64::MAX)),
        ));
    }
    json::object(members)
}

/// A long call started running: its result follows when it ends, or is lost with the socket.
#[must_use]
pub fn progress(call_id: &str) -> Value {
    json::object(vec![
        ("type", json::text("progress")),
        ("id", json::text(call_id)),
        ("state", json::text("running")),
    ])
}

/// The commit an Admin build names and that commit's time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceBuild {
    /// The full commit id.
    pub revision: String,
    /// The commit time in UTC seconds.
    pub time: i64,
}

impl SourceBuild {
    /// A source build of this protocol: a 40-hex commit id and a commit time from 1 to the latest version time.
    #[must_use]
    pub fn admitted(revision: &str, time: i64) -> Option<Self> {
        (SOURCE_REVISION_RE.is_full(revision) && 0 < time && time <= MAX_SOURCE_TIME).then(|| {
            Self {
                revision: revision.to_owned(),
                time,
            }
        })
    }
}

/// The session's two deadlines in whole seconds from now (idle, absolute), and the commit this Admin was built from.
#[must_use]
pub fn session(idle_seconds: i64, absolute_seconds: i64, source: Option<&SourceBuild>) -> Value {
    json::object(vec![
        ("type", json::text("session")),
        ("idle_seconds", json::int(idle_seconds)),
        ("absolute_seconds", json::int(absolute_seconds)),
        (
            "source_revision",
            source.map_or(Value::Null, |source| json::text(&source.revision)),
        ),
        (
            "source_time",
            source.map_or(Value::Null, |source| json::int(source.time)),
        ),
    ])
}

/// A topic changed: an invalidation only.
#[must_use]
pub fn changed(topic: &str, epoch: &str, revision: u64) -> Value {
    json::object(vec![
        ("type", json::text("changed")),
        ("topic", json::text(topic)),
        ("epoch", json::text(epoch)),
        (
            "revision",
            json::int(i64::try_from(revision).unwrap_or(i64::MAX)),
        ),
    ])
}

/// One `shimpz.chat.v7` server frame on a Team's channel, which names that Team.
///
/// # Errors
///
/// Returns `None` for an event that names another Team.
#[must_use]
pub fn chat_event(team_id: &str, event: &Value) -> Option<Value> {
    match json::get(event, "team_id") {
        Some(named) if json::as_str(named) != Some(team_id) => None,
        _ => {
            let mut frame = event.clone();
            json::set(&mut frame, "team_id", json::text(team_id));
            Some(frame)
        }
    }
}

#[cfg(test)]
mod tests;
