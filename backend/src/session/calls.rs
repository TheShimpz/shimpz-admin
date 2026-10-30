//! Admitting and answering one session socket call (ADR-0114 decision 3).
//!
//! A call is counted against its session's budgets, its request body against its operation's own bound, and it runs
//! under the Supervisor authority bound again from the current signing identity, never kept from the handshake. A
//! read's result carries the revision of the topic it reflects, taken before the read. Every call ends in exactly one
//! result, unless its socket closed first.
//!
//! An operation runs on a bounded lane as a detached job: once it starts, it runs to its end whatever happens to the
//! socket, which owns only the delivery of its result (ADR-0114, Codex review of R6). A job waiting for a worker checks
//! its socket's Origin and session again when its turn comes, and never runs once they are not current.

use std::{sync::Arc, time::Duration};

use super::{
    frames::{self, Revision},
    socket::Socket,
};
use crate::{
    app::App,
    fault::{Fault, Outcome, Reply},
    json::{self, Value},
    lanes::{Ended, Lane},
    team::transport::Team,
};

/// The longest a lane job waits for its socket's Origin and session check before the socket closes as unavailable.
const CHECK: Duration = Duration::from_secs(10);

/// The lanes the socket's calls run on.
pub struct Lanes {
    /// Reads and short changes.
    pub calls: Lane,
    /// Assistant installs, which run for minutes.
    pub install: Lane,
    /// Frozen Routine runs resuming.
    pub resume: Lane,
}

impl Default for Lanes {
    fn default() -> Self {
        Self {
            calls: Lane::new(4, 32),
            install: Lane::new(2, 4),
            resume: Lane::new(4, 8),
        }
    }
}

/// A full lane.
#[must_use]
pub fn full() -> Reply {
    Reply::detail(429, "Admin session call capacity reached")
}

/// One admitted call, as its method sees it.
pub struct Call {
    /// The socket it arrived on.
    pub socket: Arc<Socket>,
    /// Its id.
    pub id: String,
    /// Its method.
    pub method: &'static str,
    /// Its params object.
    pub params: Value,
    team: Option<Team>,
}

/// How a lane job runs.
pub struct Run<'a> {
    /// The lane.
    pub lane: &'a Lane,
    /// The answer when the lane is full.
    pub full: Reply,
    /// Whether the page hears that the call started (a long call).
    pub announce: bool,
}

impl Call {
    /// The process.
    #[must_use]
    pub fn app(&self) -> &Arc<App> {
        self.socket.app()
    }

    /// A parameter, or `null` when the call carries none.
    #[must_use]
    pub fn param(&self, name: &str) -> &Value {
        json::get(&self.params, name).unwrap_or(&Value::Null)
    }

    /// A string parameter (every parameter but `body` and `topics` is one).
    #[must_use]
    pub fn text(&self, name: &str) -> &str {
        json::as_str(self.param(name)).unwrap_or_default()
    }

    /// The request body.
    #[must_use]
    pub fn body(&self) -> &Value {
        self.param("body")
    }

    /// Team under the session's authority as it was bound when the call started.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::Authority`] for a call that changes only what the socket holds.
    pub fn team(&self) -> Result<Team, Fault> {
        self.team.clone().ok_or(Fault::Authority)
    }

    /// Runs `operation` on the call lane once the socket is still current there.
    ///
    /// # Errors
    ///
    /// Returns the operation's fault, [`Fault::Closed`] when the socket was no longer current at its turn, or
    /// [`Fault::Internal`] when it panicked.
    pub async fn on_lane<F>(&self, operation: F) -> Outcome
    where
        F: Future<Output = Outcome> + Send + 'static,
    {
        let lanes = &self.app().domains.session.lanes;
        self.run(
            Run {
                lane: &lanes.calls,
                full: full(),
                announce: false,
            },
            operation,
        )
        .await
    }

    /// Runs `operation` as `run` says, as a detached job checked against the socket when its turn comes.
    ///
    /// # Errors
    ///
    /// As [`Self::on_lane`].
    pub async fn run<F>(&self, run: Run<'_>, operation: F) -> Outcome
    where
        F: Future<Output = Outcome> + Send + 'static,
    {
        let socket = Arc::clone(&self.socket);
        let id = run.announce.then(|| self.id.clone());
        let job = run.lane.submit(async move {
            if !current(&socket).await {
                return Err(Fault::Closed);
            }
            if let Some(id) = id {
                socket.progress(&id);
            }
            operation.await
        });
        let Ok(job) = job else {
            return Ok(run.full);
        };
        match job.wait().await {
            Ended::Done(outcome) => outcome,
            Ended::Cancelled => Err(Fault::Closed),
            Ended::Panicked => Err(Fault::Internal),
        }
    }
}

/// On a lane worker: the socket's Origin and session are still current; a check that cannot answer in time closes it.
pub async fn current(socket: &Arc<Socket>) -> bool {
    let checked = Arc::clone(socket);
    if let Ok(Ok(current)) = tokio::time::timeout(
        CHECK,
        tokio::task::spawn_blocking(move || checked.authorized()),
    )
    .await
    {
        current && !socket.is_closed()
    } else {
        socket.end(super::socket::UNAVAILABLE);
        false
    }
}

/// Counts one call against its session's budgets, or the reason it is refused.
#[must_use]
pub fn admission(socket: &Socket, method: &str) -> Option<&'static str> {
    let budgets = &socket.app().domains.session.budgets;
    if !budgets.calls.admit(socket.session()) {
        return Some("session call budget reached");
    }
    if frames::is_socket_state(method) && !budgets.changes.admit(socket.session()) {
        return Some("session change budget reached");
    }
    None
}

fn oversized(call: &frames::Call) -> bool {
    frames::body_limit(call.method).is_some_and(|limit| {
        json::get(&call.params, "body").is_some_and(|body| frames::body_bytes(body) > limit)
    })
}

/// Runs one method under the current Supervisor authority, answering its failures as the HTTP gate does.
async fn dispatch(socket: &Arc<Socket>, call: frames::Call) -> Outcome {
    let team = if frames::is_socket_state(call.method) {
        None
    } else {
        Some(socket.app().session_team(socket.cookie())?)
    };
    let call = Call {
        socket: Arc::clone(socket),
        id: call.id,
        method: call.method,
        params: call.params,
        team,
    };
    let dispatched = std::panic::AssertUnwindSafe(super::methods::dispatch(&call));
    match futures_util::FutureExt::catch_unwind(dispatched).await {
        Ok(outcome) => outcome,
        Err(_) => Err(Fault::Internal),
    }
}

/// Answers one call with exactly one result; a result too large for one frame is answered as a failure.
pub async fn run(socket: &Arc<Socket>, call: frames::Call) {
    if !frames::is_read(call.method) && !socket.authorized() {
        return;
    }
    let topics = &socket.app().topics;
    let revision = frames::read_topic(call.method, &call.params)
        .filter(|topic| frames::is_topic(topic))
        .map(|topic| Revision {
            revision: topics.revision(&topic),
            epoch: topics.epoch.clone(),
            topic,
        });
    let (id, method) = (call.id.clone(), call.method);
    let team_id = json::get_str(&call.params, "team_id").map(str::to_owned);
    let reply = if oversized(&call) {
        Reply::detail(413, "request body too large")
    } else {
        match dispatch(socket, call).await {
            Ok(reply) => reply,
            Err(Fault::Closed) => return,
            Err(fault) => {
                if fault == Fault::Internal {
                    crate::command::log("error", "session_call_failed");
                }
                fault.reply()
            }
        }
    };
    let success = reply.success();
    let mut frame = frames::result(
        &id,
        reply.status,
        reply.body,
        revision.as_ref().filter(|_| success),
    );
    if frames::encode(&frame).is_err() {
        crate::command::log("warning", "session_result_exceeds_frame_bound");
        frame = frames::result(
            &id,
            502,
            json::detail("the result exceeds the session frame bound"),
            None,
        );
    }
    if socket.send(&frame, None).is_ok() && method == "chat.attach" && success {
        socket.start_channel(team_id.as_deref().unwrap_or_default());
    }
}
