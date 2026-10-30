//! A Team's Sign-in for the Supervisor (ADR-0117, 2026-10-20 amendment).
//!
//! Each Team has one Sign-in, its browser session. The Supervisor reads it, starts a sign-in session at one https site,
//! drives its Browser through the view's control stream, and Saves or cancels it; deleting it takes the Supervisor's
//! password and second factor, bound to the exact Sign-in, generation, and Team incarnation Admin read when the
//! confirmation began. Every body is checked against Team's protocol before Team is reached, and every answer is
//! admitted only in its exact form with its trace identifier, which the page never receives. A refusal passes on only as
//! one of the closed codes; anything else is a Team that is unavailable. A saved or deleted Sign-in changes the Team's
//! `sign-in` topic.
//!
//! A sign-in session belongs to the Supervisor session that started it: when that session ends, Admin cancels it under
//! the authority it was started with, so a Save under way keeps nothing.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use sha2::{Digest, Sha256};
use team_protocol::sign_in as contract;

use super::{bridge::closed_traced, transport::Team};
use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
    process::app::App,
    process::command::log,
    session::topics::Topics,
    supervisor::authority::Authority,
    sync::lock,
};

/// The Team topic a Sign-in change raises.
pub const TOPIC: &str = "sign-in";
/// How often the authorities of running sign-in sessions are checked again by the full rule.
pub const SWEEP: Duration = Duration::from_secs(30);
/// A revoked session's Cancel is asked again this often while Team cannot be reached.
pub const CANCEL_RETRY_DELAY: Duration = Duration::from_secs(5);
/// Until Team's own 30-minute limit has surely ended the session.
pub const CANCEL_RETRY: Duration = Duration::from_mins(31);

const REFUSALS: [(u16, &[&str]); 4] = [
    (400, &[contract::URL_INVALID]),
    (
        404,
        &[contract::NOT_RUNNING, contract::ABSENT, "team-not-found"],
    ),
    (
        409,
        &[
            contract::WINDOWS,
            contract::IDENTITY_PROVIDER,
            contract::BUSY,
            contract::CHANGED,
            "browser-busy",
        ],
    ),
    (
        503,
        &[
            contract::UNSAVED,
            "browser-unavailable",
            "sign-ins-unavailable",
        ],
    ),
];

type Admit = fn(&Value) -> Option<&Value>;

/// A sign-in session as Admin starts it: its Team and the authority it was started under, from before its start.
pub struct Tracked {
    team_id: String,
    authority: Authority,
    origin: String,
    session_id: Mutex<Option<String>>,
    revoked: AtomicBool,
}

#[derive(Default)]
struct Sessions {
    running: HashMap<String, Arc<Tracked>>,
    starting: Vec<Arc<Tracked>>,
}

/// Each Team's running sign-in session, every start still waiting for Team's answer, and the sweep.
#[derive(Default)]
pub struct Tracker {
    sessions: Mutex<Sessions>,
    sweep: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

fn admitted(body: &Value, admit: Admit) -> Result<Value, Fault> {
    admit(body)
        .cloned()
        .ok_or_else(|| Fault::team_request("the sign-in request is not admissible"))
}

/// Team's exact traced answer as the page's untraced one, its closed refusal, or a Team that is unavailable.
#[must_use]
pub fn answer(response: &Reply, admit: Admit) -> Reply {
    let body = &response.body;
    if response.status == 200 && body.get("trace_id").is_some() {
        let untraced = json::without(body, "trace_id");
        if let Some(answer) = admit(&untraced) {
            let names: Vec<&str> = json::members(answer)
                .unwrap_or_default()
                .iter()
                .map(|(name, _)| name.as_str())
                .collect();
            if closed_traced(body, &names) {
                return Reply::ok(answer.clone());
            }
        }
    }
    let code = response.get_str("code");
    let closed = REFUSALS.iter().any(|(status, codes)| {
        *status == response.status && code.is_some_and(|code| codes.contains(&code))
    });
    match code {
        Some(code) if closed => Reply::new(
            response.status,
            json::detail_code("sign-in unavailable", code),
        ),
        _ => Reply::detail(502, "team unavailable"),
    }
}

fn path(team_id: &str, operation: &str) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(format!("/v1/teams/{id}/browser/{operation}"))
}

async fn post(team: &Team, team_id: &str, operation: &str, body: &Value) -> Result<Reply, Fault> {
    team.call("POST", &path(team_id, operation)?, Some(body))
        .await
}

/// Starts a sign-in session: its id, the view its Browser is driven through, and its site.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an inadmissible body or id.
pub async fn start(team: &Team, team_id: &str, body: &Value) -> Result<Reply, Fault> {
    let body = admitted(body, contract::canonical_start)?;
    let response = post(team, team_id, "sign-in", &body).await?;
    Ok(answer(&response, contract::canonical_started))
}

fn changed(topics: &Topics, team_id: &str, response: Reply) -> Reply {
    if response.status == 200
        && let Ok(id) = payloads::team_id(&json::text(team_id))
    {
        topics.team_changed(&id, &[TOPIC]);
    }
    response
}

/// Saves the session as the Sign-in's next generation; once saving starts, the session ends however it goes.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an inadmissible body or id.
pub async fn save(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    body: &Value,
) -> Result<Reply, Fault> {
    let body = admitted(body, contract::canonical_session)?;
    let response = post(team, team_id, "sign-in/save", &body).await?;
    Ok(changed(
        topics,
        team_id,
        answer(&response, contract::canonical_saved),
    ))
}

/// Ends the session; a restored Sign-in then needs a person's Save before an agent uses it.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an inadmissible body or id.
pub async fn cancel(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    body: &Value,
) -> Result<Reply, Fault> {
    let body = admitted(body, contract::canonical_session)?;
    let response = post(team, team_id, "sign-in/cancel", &body).await?;
    Ok(changed(
        topics,
        team_id,
        answer(&response, contract::canonical_cancelled),
    ))
}

/// The Team's Sign-in, or null when it has none.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn current(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let response = team.call("GET", &path(team_id, "sign-in")?, None).await?;
    Ok(answer(&response, contract::canonical_current))
}

/// The one exact deletion a Supervisor confirms: this Team's Sign-in, at this generation and incarnation.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub fn deletion_subject(team_id: &str, sign_in: &Value) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let field = |name: &str| sign_in.get(name).cloned().unwrap_or(Value::Null);
    let identity = Value::Array(vec![
        json::text(id),
        field("team_incarnation"),
        field("sign_in_id"),
        field("generation"),
    ]);
    let digest = Sha256::digest(json::compact(&identity).as_bytes());
    Ok(format!(
        "sign-in-delete:{}",
        data_encoding::HEXLOWER.encode(&digest)
    ))
}

/// A person's request body as Team takes it: naming their Admin page's verified Origin, never one it sent.
#[must_use]
pub fn with_origin(body: &Value, origin: &str) -> Value {
    if json::members(body).is_none() {
        return body.clone();
    }
    let mut named = body.clone();
    json::set(&mut named, "origin", json::text(origin));
    named
}

/// The value of a Python `str.isdecimal()` text as `int()` reads it, or `None` for any other text.
fn decimal(text: &str) -> Option<i64> {
    if text.is_empty() {
        return None;
    }
    let mut value: i64 = 0;
    for character in text.chars() {
        if team_protocol::python::text::category(character) != "Nd" {
            return None;
        }
        let mut start = character as u32;
        while start > 0
            && char::from_u32(start - 1)
                .is_some_and(|before| team_protocol::python::text::category(before) == "Nd")
        {
            start -= 1;
        }
        let digit = i64::from((character as u32 - start) % 10);
        value = value.saturating_mul(10).saturating_add(digit);
    }
    Some(value)
}

/// The Sign-in a deletion names, as its socket call carries it; a form outside Team's protocol is refused.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other form.
pub fn confirmed(
    sign_in_id: &Value,
    generation: &Value,
    team_incarnation: &Value,
) -> Result<Value, Fault> {
    let number = json::as_str(generation)
        .and_then(decimal)
        .map_or(Value::Null, json::int);
    let named = json::object(vec![
        ("sign_in_id", sign_in_id.clone()),
        ("generation", number),
        ("team_incarnation", team_incarnation.clone()),
    ]);
    let probe = json::merged(
        &named,
        &json::object(vec![
            ("factor", json::text("totp")),
            ("origin", json::text("https://admin.invalid")),
        ]),
    );
    if contract::canonical_delete(&probe).is_none() {
        return Err(Fault::team_request(
            "the Sign-in to delete is not admissible",
        ));
    }
    Ok(named)
}

/// Deletes exactly the confirmed Sign-in, telling Team the second factor and the Origin that confirmed it.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an inadmissible body or id.
pub async fn delete(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    named: &Value,
    factor: &str,
    origin: &str,
) -> Result<Reply, Fault> {
    let body = json::merged(
        named,
        &json::object(vec![
            ("factor", json::text(factor)),
            ("origin", json::text(origin)),
        ]),
    );
    let body = admitted(&body, contract::canonical_delete)?;
    let response = post(team, team_id, "sign-in/delete", &body).await?;
    Ok(changed(
        topics,
        team_id,
        answer(&response, contract::canonical_deleted),
    ))
}

impl Tracker {
    /// Starts a sign-in session that belongs to `authority`, tracked before Team is asked.
    ///
    /// A revocation that comes while its Browser starts still cancels it once Team answers. A start Team refuses
    /// changes nothing already tracked.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for an inadmissible body or id.
    pub async fn start_under(
        &self,
        app: &Arc<App>,
        team: &Team,
        authority: Authority,
        team_id: &str,
        body: &Value,
    ) -> Result<Reply, Fault> {
        let id = payloads::team_id(&json::text(team_id))?;
        let origin = json::get_str(body, "origin").unwrap_or_default().to_owned();
        let tracked = Arc::new(Tracked {
            team_id: id.clone(),
            authority,
            origin,
            session_id: Mutex::new(None),
            revoked: AtomicBool::new(false),
        });
        lock(&self.sessions).starting.push(Arc::clone(&tracked));
        let response = start(team, &id, body).await;
        let running = {
            let mut sessions = lock(&self.sessions);
            sessions
                .starting
                .retain(|item| !Arc::ptr_eq(item, &tracked));
            let started = response.as_ref().ok().filter(|reply| reply.status == 200);
            if let Some(reply) = started {
                *lock(&tracked.session_id) = reply.get_str("sign_in_session_id").map(str::to_owned);
                if !tracked.revoked.load(Ordering::SeqCst) {
                    sessions.running.insert(id, Arc::clone(&tracked));
                }
            }
            started.is_some()
        };
        if running && tracked.revoked.load(Ordering::SeqCst) {
            cancel_apart(app, tracked);
        }
        response
    }

    /// That sign-in session was saved or cancelled: its authority's end has nothing left to cancel.
    pub fn finished(&self, team_id: &str, session_id: Option<&str>) {
        let mut sessions = lock(&self.sessions);
        let same = sessions
            .running
            .get(team_id)
            .is_some_and(|tracked| lock(&tracked.session_id).as_deref() == session_id);
        if same {
            sessions.running.remove(team_id);
        }
    }

    /// Cancels every running session whose authority `ended`; one still starting is cancelled once Team answers.
    fn revoke(&self, app: &Arc<App>, ended: impl Fn(&Tracked) -> bool) {
        let revoked: Vec<Arc<Tracked>> = {
            let mut sessions = lock(&self.sessions);
            for tracked in &sessions.starting {
                if ended(tracked) {
                    tracked.revoked.store(true, Ordering::SeqCst);
                }
            }
            let ids: Vec<String> = sessions
                .running
                .iter()
                .filter(|(_, tracked)| ended(tracked))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| sessions.running.remove(id))
                .collect()
        };
        for tracked in revoked {
            cancel_apart(app, tracked);
        }
    }

    /// Supervisor sessions stopped being tracked: cancels every sign-in session one of them started.
    pub fn sessions_ended(&self, app: &Arc<App>, sessions: Option<&HashSet<String>>) {
        self.revoke(app, |tracked| {
            sessions.is_none_or(|ended| ended.contains(&tracked.authority.session))
        });
    }

    /// From the first start on, checks every tracked authority again by the full rule.
    pub fn sweep(&self, app: &Arc<App>) {
        let mut sweep = lock(&self.sweep);
        if sweep
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished)
        {
            *sweep = Some(tokio::spawn(run_sweep(Arc::downgrade(app))));
        }
    }

    fn tracked(&self) -> Vec<Arc<Tracked>> {
        let sessions = lock(&self.sessions);
        sessions
            .starting
            .iter()
            .chain(sessions.running.values())
            .cloned()
            .collect()
    }
}

async fn run_sweep(app: std::sync::Weak<App>) {
    loop {
        tokio::time::sleep(SWEEP).await;
        let Some(app) = app.upgrade() else {
            return;
        };
        let tracker = &app.domains.team.sign_ins;
        let lapsed: Vec<Arc<Tracked>> = tracker
            .tracked()
            .into_iter()
            .filter(|tracked| !tracked.authority.current())
            .collect();
        tracker.revoke(&app, |item| {
            lapsed
                .iter()
                .any(|known| std::ptr::eq(Arc::as_ptr(known), item))
        });
    }
}

/// Registers the tracker with the process's sessions, so an ended Supervisor session cancels its sign-in sessions.
pub fn listen(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    app.sessions.listen(Arc::new(move |ended| {
        if let Some(app) = weak.upgrade() {
            app.domains.team.sign_ins.sessions_ended(&app, ended);
        }
    }));
}

fn cancel_apart(app: &Arc<App>, tracked: Arc<Tracked>) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(cancel_ended(Arc::clone(app), tracked));
    }
}

/// Delivers the revoked session's Cancel until Team confirms it, it no longer runs, or Team's own limit ended it.
async fn cancel_ended(app: Arc<App>, tracked: Arc<Tracked>) {
    let deadline = tokio::time::Instant::now() + CANCEL_RETRY;
    let session_id = lock(&tracked.session_id).clone().unwrap_or_default();
    let body = json::object(vec![
        ("sign_in_session_id", json::text(session_id)),
        ("origin", json::text(&tracked.origin)),
    ]);
    loop {
        if let Ok(team) = tracked.authority.team()
            && let Ok(response) = cancel(&team, &app.topics, &tracked.team_id, &body).await
            && (matches!(response.status, 200 | 404)
                || response.get_str("code") == Some("browser-unavailable"))
        {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            log("warning", "sign_in_revoked_cancel_failed");
            return;
        }
        tokio::time::sleep(CANCEL_RETRY_DELAY).await;
    }
}

#[cfg(test)]
mod tests;
