//! Fail-closed browser projection of Team-owned Action human challenges, and the Supervisor's answer to one.
//!
//! A challenge reaches the browser only in its exact public shape, its request fingerprinted as Team computed it. An
//! answer is checked against the request it answers; an Action password is verified here by Admin's own bounded
//! authority (three attempts, then a minute's lock), and only the assurance that it passed reaches Team.

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use data_encoding::HEXLOWER;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use team_protocol::{
    challenge as team_challenge, payload as team_contract,
    purpose::canonical_purpose,
    python::{
        regex::{Pattern, declared},
        text,
    },
    websocket::{FrameError, canonical_human_response, challenge_identity, public_text},
};

use crate::{
    chat::payloads,
    json::{self, Value},
    record::Store,
    signin::password,
    team::bridge::is_trace_id,
    time::clock::Clock,
};

/// The longest a challenge stays open.
pub const MAX_TTL_SECONDS: i64 = 300;
/// The longest Action password.
pub const MAX_AUTH_SECRET_CHARS: usize = 4096;
/// The most requests one Action makes.
pub const MAX_REQUESTS_PER_ACTION: i64 = 8;
/// Wrong Action passwords before the lock.
pub const MAX_PASSWORD_ATTEMPTS: u32 = 3;
/// The lock after them.
pub const PASSWORD_LOCK: Duration = Duration::from_secs(60);
/// What a human-required challenge shows, beside its envelope.
pub const CHALLENGE_FIELDS: [&str; 8] = [
    "challenge_id",
    "expires_in",
    "assistant",
    "action",
    "request",
    "rendered",
    "locale",
    "pack_digest",
];
/// Optional presentation beside the Assistant-authored request, never part of its fingerprint.
pub const PRESENTATION_FIELDS: [&str; 5] = ["purpose", "help", "help_url", "file", "input"];
const LENGTH_KINDS: [(&str, i64); 4] = [
    ("input:text", 4096),
    ("input:textarea", 16_000),
    ("input:password", 1024),
    ("input:phone", 64),
];
const CHOICE_KINDS: [&str; 2] = ["input:select", "input:choice"];
const AUTH_KINDS: [&str; 1] = ["auth:password"];
const AUTHORIZATION_KINDS: [&str; 2] = ["approval", "auth:password"];
const MAX_REFERENCE_PARAMS: usize = 8;
const MAX_INTEGER_PARAM: i64 = 1_000_000_000_000_000;

static MESSAGE_ID: LazyLock<Pattern> = LazyLock::new(|| declared(r"[0-9a-f]{64}\Z"));
static PARAM_NAME: LazyLock<Pattern> = LazyLock::new(|| declared(r"[a-z][a-z0-9_]{0,31}\Z"));
static DNS_NAME_PARAM: LazyLock<Pattern> = LazyLock::new(|| {
    declared(
        r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\Z",
    )
});
static IDENTIFIER_PARAM: LazyLock<Pattern> =
    LazyLock::new(|| declared(r"[A-Za-z0-9][A-Za-z0-9._:-]*\Z"));

/// The Team response is not one exact public human challenge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HumanChallengeError;

fn exact<'a>(body: &'a Value, fields: &[&str]) -> Option<&'a [(String, Value)]> {
    json::has_exactly(body, fields).then(|| json::members(body).unwrap_or_default())
}

/// One immutable public challenge projected from Team's envelope, or a refusal that reflects nothing.
///
/// # Errors
///
/// Returns [`HumanChallengeError`] for any body outside the exact challenge shape.
pub fn project(body: &Value, team_id: &str) -> Result<Value, HumanChallengeError> {
    let members = json::members(body).ok_or(HumanChallengeError)?;
    let mut required: Vec<&str> = vec!["team_id", "status", "turn_id", "trace_id"];
    required.extend(CHALLENGE_FIELDS);
    let names: Vec<&str> = members.iter().map(|(name, _)| name.as_str()).collect();
    if !required.iter().all(|name| names.contains(name))
        || !names
            .iter()
            .all(|name| required.contains(name) || PRESENTATION_FIELDS.contains(name))
    {
        return Err(HumanChallengeError);
    }
    if json::get_str(body, "team_id") != Some(team_id)
        || json::get_str(body, "status") != Some("human-required")
    {
        return Err(HumanChallengeError);
    }
    let (challenge_id, turn_id) = challenge_identity(body, team_id).ok_or(HumanChallengeError)?;
    if !body.get("trace_id").is_some_and(is_trace_id) {
        return Err(HumanChallengeError);
    }
    let expires_in = body
        .get("expires_in")
        .and_then(json::as_int)
        .filter(|expires| (1..=MAX_TTL_SECONDS).contains(expires))
        .ok_or(HumanChallengeError)?;
    let assistant = assistant(body.get("assistant").unwrap_or(&Value::Null))?;
    let action = action(body.get("action").unwrap_or(&Value::Null))?;
    let request = request(body.get("request").unwrap_or(&Value::Null))?;
    let mut projected = vec![
        ("team_id", json::text(team_id)),
        ("status", json::text("human-required")),
        ("turn_id", json::text(turn_id)),
        ("challenge_id", json::text(challenge_id)),
        ("expires_in", json::int(expires_in)),
        ("assistant", assistant),
        ("action", action),
    ];
    let (localization, presentation) =
        (localization(body, &request)?, presentation(body, &request)?);
    projected.push(("request", request));
    let mut value = json::object(projected);
    for (name, item) in localization.into_iter().chain(presentation) {
        json::set(&mut value, name, item);
    }
    Ok(value)
}

fn localization(
    body: &Value,
    request: &Value,
) -> Result<Vec<(&'static str, Value)>, HumanChallengeError> {
    let rendered =
        team_challenge::canonical_rendered(body.get("rendered").unwrap_or(&Value::Null), request)
            .cloned()
            .ok_or(HumanChallengeError)?;
    let locale = team_contract::canonical_locale(body.get("locale").unwrap_or(&Value::Null))
        .ok_or(HumanChallengeError)?;
    let pack =
        team_contract::canonical_pack_digest(body.get("pack_digest").unwrap_or(&Value::Null))
            .ok_or(HumanChallengeError)?;
    Ok(vec![
        ("rendered", rendered),
        ("locale", json::text(locale)),
        ("pack_digest", json::text(pack)),
    ])
}

fn presentation(
    body: &Value,
    request: &Value,
) -> Result<Vec<(&'static str, Value)>, HumanChallengeError> {
    let mut shown: Vec<(&'static str, Value)> = Vec::new();
    if let Some(purpose) = body.get("purpose") {
        shown.push((
            "purpose",
            json::text(canonical_purpose(purpose).ok_or(HumanChallengeError)?),
        ));
    }
    let kind = json::get_str(request, "kind").unwrap_or_default();
    let stored = kind == "input:password" && json::contains(request, "stored_input");
    if stored {
        let help =
            team_contract::canonical_stored_input_help(body.get("help").unwrap_or(&Value::Null));
        let url = team_contract::canonical_help_url(body.get("help_url").unwrap_or(&Value::Null));
        let (Some(help), Some(url)) = (help, url) else {
            return Err(HumanChallengeError);
        };
        shown.push(("help", json::text(help)));
        shown.push(("help_url", json::text(url)));
    } else if json::contains(body, "help") || json::contains(body, "help_url") {
        return Err(HumanChallengeError);
    }
    if let Some(file) = body.get("file") {
        let disclosed =
            team_challenge::canonical_file_disclosure(file).ok_or(HumanChallengeError)?;
        if !AUTHORIZATION_KINDS.contains(&kind) {
            return Err(HumanChallengeError);
        }
        shown.push(("file", disclosed));
    }
    if let Some(input) = body.get("input") {
        let rows = team_challenge::canonical_input_projection(input).ok_or(HumanChallengeError)?;
        if !AUTHORIZATION_KINDS.contains(&kind) {
            return Err(HumanChallengeError);
        }
        shown.push(("input", rows.clone()));
    }
    Ok(shown)
}

fn assistant(value: &Value) -> Result<Value, HumanChallengeError> {
    exact(value, &["id", "name", "version"]).ok_or(HumanChallengeError)?;
    let id = payloads::assistant_id(value.get("id").unwrap_or(&Value::Null))
        .map_err(|_| HumanChallengeError)?;
    let name = public_text(value.get("name").unwrap_or(&Value::Null), 80)
        .map_err(|_| HumanChallengeError)?;
    let version = public_text(value.get("version").unwrap_or(&Value::Null), 40)
        .map_err(|_| HumanChallengeError)?;
    Ok(json::object(vec![
        ("id", json::text(id)),
        ("name", json::text(name)),
        ("version", json::text(version)),
    ]))
}

fn action(value: &Value) -> Result<Value, HumanChallengeError> {
    exact(value, &["id", "summary"]).ok_or(HumanChallengeError)?;
    let id = payloads::action_id(value.get("id").unwrap_or(&Value::Null))
        .map_err(|_| HumanChallengeError)?;
    let summary = public_text(value.get("summary").unwrap_or(&Value::Null), 160)
        .map_err(|_| HumanChallengeError)?;
    Ok(json::object(vec![
        ("id", json::text(id)),
        ("summary", json::text(summary)),
    ]))
}

fn request(value: &Value) -> Result<Value, HumanChallengeError> {
    json::members(value).ok_or(HumanChallengeError)?;
    let mut request = value.clone();
    let fingerprint = json::remove(&mut request, "fingerprint").ok_or(HumanChallengeError)?;
    let fingerprint = json::as_str(&fingerprint)
        .filter(|fingerprint| {
            team_contract::SHA256_RE.is_full(fingerprint) && fingerprinted(&request, fingerprint)
        })
        .ok_or(HumanChallengeError)?
        .to_owned();
    let kind = json::get_str(&request, "kind")
        .ok_or(HumanChallengeError)?
        .to_owned();
    let ordinal = request.get("ordinal").and_then(json::as_int);
    if ordinal.is_none_or(|ordinal| !(0..MAX_REQUESTS_PER_ACTION).contains(&ordinal))
        || !reference(request.get("title"))
        || !reference(request.get("description"))
        || !kind_shape(&request, &kind)
    {
        return Err(HumanChallengeError);
    }
    json::set(&mut request, "fingerprint", json::text(fingerprint));
    Ok(request)
}

fn fingerprinted(request: &Value, supplied: &str) -> bool {
    let canonical = json::dumps(request, json::SORTED);
    let expected = HEXLOWER.encode(&Sha256::digest(canonical.as_bytes()));
    bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()))
}

fn kind_shape(request: &Value, kind: &str) -> bool {
    let base = ["kind", "ordinal", "title", "description"];
    let with = |extra: &[&str]| {
        let mut fields: Vec<&str> = base.to_vec();
        fields.extend_from_slice(extra);
        json::has_exactly(request, &fields)
    };
    if kind == "approval" || AUTH_KINDS.contains(&kind) {
        return with(&[]);
    }
    if let Some((_, limit)) = LENGTH_KINDS.iter().find(|(name, _)| *name == kind) {
        let mut extra = vec![
            "label",
            "required",
            "placeholder",
            "min_length",
            "max_length",
        ];
        if kind == "input:password" {
            if team_protocol::identifiers::canonical_identifier(
                request.get("stored_input").unwrap_or(&Value::Null),
            )
            .is_none()
            {
                return false;
            }
            extra.push("stored_input");
        }
        return with(&extra) && length(request, *limit);
    }
    if CHOICE_KINDS.contains(&kind) {
        return with(&["label", "required", "options"]) && choices(request, false);
    }
    kind == "input:choices"
        && with(&[
            "label",
            "required",
            "options",
            "min_selections",
            "max_selections",
        ])
        && choices(request, true)
}

fn input_base(request: &Value) -> bool {
    matches!(request.get("required"), Some(Value::Bool(_))) && reference(request.get("label"))
}

fn length(request: &Value, limit: i64) -> bool {
    let minimum = request.get("min_length").and_then(json::as_int);
    let maximum = request.get("max_length").and_then(json::as_int);
    let placeholder = request.get("placeholder");
    input_base(request)
        && (matches!(placeholder, Some(Value::Null)) || reference(placeholder))
        && matches!((minimum, maximum), (Some(minimum), Some(maximum)) if 0 <= minimum && minimum <= maximum && maximum <= limit)
}

fn choices(request: &Value, multiple: bool) -> bool {
    let Some(options) = request.get("options").and_then(json::as_array) else {
        return false;
    };
    if !input_base(request) || !(2..=32).contains(&options.len()) || !options.iter().all(option) {
        return false;
    }
    let mut values: Vec<&str> = options
        .iter()
        .filter_map(|option| json::get_str(option, "value"))
        .collect();
    values.sort_unstable();
    values.dedup();
    if values.len() != options.len() {
        return false;
    }
    if !multiple {
        return true;
    }
    let minimum = request.get("min_selections").and_then(json::as_int);
    let maximum = request.get("max_selections").and_then(json::as_int);
    let count = i64::try_from(options.len()).unwrap_or(0);
    matches!((minimum, maximum), (Some(minimum), Some(maximum)) if 0 <= minimum && minimum <= maximum && maximum <= count)
}

fn option(value: &Value) -> bool {
    let description = value.get("description");
    json::has_exactly(value, &["value", "label", "description"])
        && json::get_str(value, "value").is_some_and(|text| plain_text(text, 128))
        && reference(value.get("label"))
        && (matches!(description, Some(Value::Null)) || reference(description))
}

fn plain_text(value: &str, maximum: usize) -> bool {
    text::strip(value) == value
        && (1..=maximum).contains(&text::len(value))
        && text::isprintable(value)
}

fn reference(value: Option<&Value>) -> bool {
    let Some(value) = value.filter(|value| json::has_exactly(value, &["message", "params"])) else {
        return false;
    };
    let message = value
        .get("message")
        .is_some_and(|message| MESSAGE_ID.is_full_value(message));
    let params = value
        .get("params")
        .and_then(json::members)
        .is_some_and(|params| {
            params.len() <= MAX_REFERENCE_PARAMS
                && params
                    .iter()
                    .all(|(name, item)| PARAM_NAME.is_full(name) && param(item))
        });
    message && params
}

fn param(value: &Value) -> bool {
    if let Some(number) = json::as_int(value) {
        return (0..MAX_INTEGER_PARAM).contains(&number);
    }
    json::as_str(value).is_some_and(|text| {
        (text::len(text) <= 253 && DNS_NAME_PARAM.is_full(text))
            || (text::len(text) <= 128 && IDENTIFIER_PARAM.is_full(text))
    })
}

/// Whether a browser value answers exactly this already-projected request.
#[must_use]
pub fn browser_value(request: &Value, value: &Value) -> bool {
    let kind = json::get_str(request, "kind").unwrap_or_default();
    if kind == "approval" {
        return matches!(value, Value::Bool(true));
    }
    if AUTH_KINDS.contains(&kind) {
        return json::as_str(value).is_some_and(|secret| (1..=4096).contains(&text::len(secret)));
    }
    let required = matches!(request.get("required"), Some(Value::Bool(true)));
    let allowed: Vec<&str> = request
        .get("options")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|option| json::get_str(option, "value"))
        .collect();
    if CHOICE_KINDS.contains(&kind) {
        return json::as_str(value)
            .is_some_and(|choice| allowed.contains(&choice) || (choice.is_empty() && !required));
    }
    if kind == "input:choices" {
        return browser_choices(request, value, &allowed);
    }
    if LENGTH_KINDS.iter().any(|(name, _)| *name == kind) {
        let minimum = request.get("min_length").and_then(json::as_int);
        let maximum = request.get("max_length").and_then(json::as_int);
        return json::as_str(value).is_some_and(|text_value| {
            let length = i64::try_from(text::len(text_value)).unwrap_or(i64::MAX);
            (!required || !text_value.is_empty())
                && matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum <= length && length <= maximum)
        });
    }
    false
}

fn browser_choices(request: &Value, value: &Value, allowed: &[&str]) -> bool {
    let Some(items) = json::as_array(value) else {
        return false;
    };
    let chosen: Vec<&str> = items.iter().filter_map(json::as_str).collect();
    let mut unique = chosen.clone();
    unique.sort_unstable();
    unique.dedup();
    let minimum = request.get("min_selections").and_then(json::as_int);
    let maximum = request.get("max_selections").and_then(json::as_int);
    let count = i64::try_from(chosen.len()).unwrap_or(i64::MAX);
    chosen.len() == items.len()
        && unique.len() == chosen.len()
        && matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum <= count && count <= maximum)
        && chosen.iter().all(|choice| allowed.contains(choice))
}

/// The outcome of one Action password check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticationResult {
    /// The password is the Supervisor's.
    Verified,
    /// It is not; this many attempts remain before the lock.
    Denied(u32),
    /// Too many wrong passwords: try again after this many seconds.
    Locked(u64),
    /// The check could not run.
    Unavailable,
}

struct AuthorityState {
    failures: u32,
    locked_until_ms: i64,
}

/// The one Local Supervisor's bounded Action password ceremony, serialized, shared by chat and frozen Routine runs.
pub struct ActionPasswords {
    store: Arc<Store>,
    clock: Arc<Clock>,
    state: tokio::sync::Mutex<AuthorityState>,
}

impl ActionPasswords {
    /// No attempt yet.
    #[must_use]
    pub fn new(store: Arc<Store>, clock: Arc<Clock>) -> Self {
        Self {
            store,
            clock,
            state: tokio::sync::Mutex::new(AuthorityState {
                failures: 0,
                locked_until_ms: 0,
            }),
        }
    }

    async fn verify(&self, kind: &str, secret: &str) -> AuthenticationResult {
        if kind != "auth:password" || !(1..=MAX_AUTH_SECRET_CHARS).contains(&text::len(secret)) {
            return AuthenticationResult::Unavailable;
        }
        let Ok(record) = self.store.get() else {
            return AuthenticationResult::Unavailable;
        };
        let secret = zeroize::Zeroizing::new(secret.to_owned());
        match tokio::task::spawn_blocking(move || password::verify_password(&secret, &record)).await
        {
            Ok(Ok(true)) => AuthenticationResult::Verified,
            Ok(Ok(false)) => AuthenticationResult::Denied(0),
            _ => AuthenticationResult::Unavailable,
        }
    }

    /// Checks one Action password: three wrong ones lock the ceremony for a minute; only a verified one resets it.
    pub async fn authenticate(&self, kind: &str, secret: &str) -> AuthenticationResult {
        let mut state = self.state.lock().await;
        let now = self.clock.monotonic_ms();
        if state.locked_until_ms > now {
            let remaining = u64::try_from((state.locked_until_ms - now + 999) / 1000)
                .unwrap_or(1)
                .max(1);
            return AuthenticationResult::Locked(remaining);
        }
        if state.locked_until_ms != 0 {
            state.failures = 0;
            state.locked_until_ms = 0;
        }
        match self.verify(kind, secret).await {
            AuthenticationResult::Verified => {
                state.failures = 0;
                state.locked_until_ms = 0;
                AuthenticationResult::Verified
            }
            AuthenticationResult::Denied(_) => {
                state.failures += 1;
                let remaining = MAX_PASSWORD_ATTEMPTS.saturating_sub(state.failures);
                if remaining > 0 {
                    return AuthenticationResult::Denied(remaining);
                }
                let lock = i64::try_from(PASSWORD_LOCK.as_millis()).unwrap_or(60_000);
                state.locked_until_ms = self.clock.monotonic_ms() + lock;
                AuthenticationResult::Locked(PASSWORD_LOCK.as_secs())
            }
            other => other,
        }
    }
}

/// What one human answer projects to: Team's continuation payload, the assurance an authenticated answer carries, the
/// rejection a wrong password is answered with, or the failure an unavailable check ends the request with.
#[derive(Clone, Debug, PartialEq)]
pub struct Answered {
    /// The continuation payload, unless the answer was rejected.
    pub payload: Option<Value>,
    /// The assurance an authenticated answer carries.
    pub assurance: Option<Value>,
    /// The `human-response-rejected` event of a wrong or locked password.
    pub rejection: Option<Value>,
    /// The terminal failure of a password Admin could not check: the request is denied.
    pub failure: Option<(u16, &'static str)>,
}

/// Projects one browser answer onto the exact Team continuation payload.
///
/// # Errors
///
/// Returns [`FrameError`] for an answer outside the frame or one that does not answer its request.
pub async fn response_payload(
    frame: &Value,
    request: &Value,
    passwords: &ActionPasswords,
) -> Result<Answered, FrameError> {
    let canonical = canonical_human_response(frame)?;
    let challenge = json::get_str(&canonical, "challenge_id")
        .unwrap_or_default()
        .to_owned();
    let deny = || {
        json::object(vec![
            ("challenge_id", json::text(&challenge)),
            ("decision", json::text("deny")),
        ])
    };
    if json::get_str(&canonical, "decision") == Some("deny") {
        return Ok(Answered {
            payload: Some(deny()),
            assurance: None,
            rejection: None,
            failure: None,
        });
    }
    let value = canonical.get("value").cloned().unwrap_or(Value::Null);
    if !browser_value(request, &value) {
        return Err(FrameError {
            status: 400,
            detail: "human response does not match its request",
            close_code: 1007,
        });
    }
    let kind = json::get_str(request, "kind").unwrap_or_default();
    if !AUTH_KINDS.contains(&kind) {
        let payload = json::object(vec![
            ("challenge_id", json::text(&challenge)),
            ("decision", json::text("submit")),
            ("value", value),
        ]);
        return Ok(Answered {
            payload: Some(payload),
            assurance: None,
            rejection: None,
            failure: None,
        });
    }
    let secret = zeroize::Zeroizing::new(json::as_str(&value).unwrap_or_default().to_owned());
    drop(value);
    Ok(authenticated(&challenge, kind, &secret, passwords).await)
}

async fn authenticated(
    challenge: &str,
    kind: &str,
    secret: &str,
    passwords: &ActionPasswords,
) -> Answered {
    match passwords.authenticate(kind, secret).await {
        AuthenticationResult::Verified => Answered {
            payload: Some(json::object(vec![
                ("challenge_id", json::text(challenge)),
                ("decision", json::text("submit")),
                ("value", Value::Bool(true)),
            ])),
            assurance: Some(json::object(vec![
                ("kind", json::text(kind)),
                ("challenge_id", json::text(challenge)),
            ])),
            rejection: None,
            failure: None,
        },
        AuthenticationResult::Denied(remaining) => {
            rejected(challenge, "authentication-denied", remaining, 0)
        }
        AuthenticationResult::Locked(retry_after) => {
            rejected(challenge, "authentication-locked", 0, retry_after)
        }
        AuthenticationResult::Unavailable => Answered {
            payload: Some(json::object(vec![
                ("challenge_id", json::text(challenge)),
                ("decision", json::text("deny")),
            ])),
            assurance: None,
            rejection: None,
            failure: Some((503, "authentication is unavailable")),
        },
    }
}

fn rejected(challenge: &str, reason: &str, remaining: u32, retry_after: u64) -> Answered {
    Answered {
        payload: None,
        assurance: None,
        rejection: Some(json::object(vec![
            ("type", json::text("human-response-rejected")),
            ("challenge_id", json::text(challenge)),
            ("reason", json::text(reason)),
            ("attempts_remaining", json::int(i64::from(remaining))),
            (
                "retry_after",
                json::int(i64::try_from(retry_after).unwrap_or(0)),
            ),
        ])),
        failure: None,
    }
}

#[cfg(test)]
mod tests;
