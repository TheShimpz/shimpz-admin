//! Each Team's chat run in Admin (ADR-0119): the run that outlives its pages, the pages that watch it, and its ending.
//!
//! A run dispatches its Team's `shimpz.chat.v7` frames one at a time, each under the Supervisor authority it was
//! admitted with; closing a page only stops watching. Only Stop, a revoked authority, the Team's deletion, or a Space
//! reset ends a run's work.

mod registry;
mod relay;

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
};

pub use registry::{channel, end_runs, run_for};
pub use relay::{Observer, Relay};
use tokio::sync::mpsc;

use super::{
    connection::{Connection, TaskHandle},
    projection::error_terminal,
    socket::{self, Ctx, Disconnected},
};
use crate::{
    app::App,
    authority::Authority,
    command::log,
    json::{self, Value},
    sync::lock,
};

/// The frames one Team's run may hold while an earlier one dispatches.
pub const MAX_WAITING_FRAMES: usize = 8;
/// The latest steps of a run's delivery a page that attaches is shown.
pub const LIVE_STEPS: usize = 64;

struct Queued {
    frame: Value,
    authority: Authority,
    observer: Option<Observer>,
}

#[derive(Default)]
struct RunState {
    observers: Vec<Observer>,
    authority: Option<Authority>,
    live: Vec<Value>,
    started: Option<Instant>,
    position: Option<usize>,
    ending: bool,
    dispatching: bool,
}

/// One Team's chat in Admin.
pub struct Run {
    app: Arc<App>,
    /// The Team.
    pub team_id: String,
    connection: Mutex<Connection>,
    state: Mutex<RunState>,
    frames: mpsc::Sender<Queued>,
    task: Mutex<Option<TaskHandle>>,
}

impl Run {
    fn start(app: &Arc<App>, team_id: &str) -> Arc<Self> {
        let (frames, receiver) = mpsc::channel(MAX_WAITING_FRAMES);
        let run = Arc::new(Self {
            app: Arc::clone(app),
            team_id: team_id.to_owned(),
            connection: Mutex::new(Connection::default()),
            state: Mutex::new(RunState::default()),
            frames,
            task: Mutex::new(None),
        });
        let looping = Arc::clone(&run);
        *lock(&run.task) = Some(TaskHandle::spawn(move |_| looping.run_loop(receiver)));
        run
    }

    /// The process.
    #[must_use]
    pub const fn app(&self) -> &Arc<App> {
        &self.app
    }

    /// The run's chat state.
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        lock(&self.connection)
    }

    /// The authority of the operation the run does now.
    #[must_use]
    pub fn authority(&self) -> Option<Authority> {
        lock(&self.state).authority.clone()
    }

    /// Whether anything of the run is under way.
    #[must_use]
    pub fn busy(&self) -> bool {
        let waiting = self.frames.capacity() < MAX_WAITING_FRAMES;
        let dispatching = lock(&self.state).dispatching;
        let connection = self.connection();
        dispatching
            || connection.active.is_some()
            || connection.sync_task.is_some()
            || connection.lifecycle.is_some()
            || waiting
    }

    // Pages

    fn attach(self: &Arc<Self>, observer: &Observer, authority: Authority, locale: &str) {
        self.observe(observer);
        if self.busy() {
            Self::push(observer, &self.snapshot());
        } else {
            let frame = json::object(vec![
                ("type", json::text("sync")),
                ("locale", json::text(locale)),
            ]);
            self.submit(frame, authority, Some(observer.clone()));
        }
    }

    fn observe(&self, observer: &Observer) {
        let mut state = lock(&self.state);
        if !state.observers.contains(observer) {
            state.observers.push(observer.clone());
        }
    }

    fn detach(&self, observer: &Observer) {
        let empty = {
            let mut state = lock(&self.state);
            state.observers.retain(|known| known != observer);
            state.observers.is_empty()
        };
        if empty {
            self.connection().lifecycle_proposal = None;
            if !self.busy() {
                self.retire();
            }
        }
    }

    /// Where the run is now, as one `running` event: how long it has run, its queue place, its latest step's sequence
    /// (`cursor`), and its latest steps.
    #[must_use]
    pub fn snapshot(&self) -> Value {
        let state = lock(&self.state);
        let elapsed = state.started.map_or(0, |started| {
            i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
        });
        let cursor = state
            .live
            .last()
            .and_then(|event| event.get("seq"))
            .cloned()
            .unwrap_or(json::int(0));
        json::object(vec![
            ("type", json::text("running")),
            ("elapsed_ms", json::int(elapsed.max(0))),
            (
                "position",
                state.position.map_or(Value::Null, |place| {
                    json::int(i64::try_from(place).unwrap_or(i64::MAX))
                }),
            ),
            ("cursor", cursor),
            ("events", Value::Array(state.live.clone())),
        ])
    }

    /// Records what a page attaching later must see, then hands the event to every page attached now.
    pub fn publish(&self, event: &Value) {
        let observers = {
            let mut state = lock(&self.state);
            if json::get_str(event, "type") == Some("progress") {
                if event.get("seq") == Some(&json::int(1)) {
                    state.live.clear();
                }
                state.live.push(event.clone());
                let excess = state.live.len().saturating_sub(LIVE_STEPS);
                state.live.drain(..excess);
            }
            state.observers.clone()
        };
        let failed: Vec<Observer> = observers
            .into_iter()
            .filter(|observer| !Self::push(observer, event))
            .collect();
        if !failed.is_empty() {
            lock(&self.state)
                .observers
                .retain(|known| !failed.contains(known));
        }
    }

    /// Hands one event to one page; whether it took it.
    fn push(observer: &Observer, event: &Value) -> bool {
        observer.push(event)
    }

    /// Hands one event to one page, which stops watching when it cannot take it.
    pub fn push_to(&self, observer: &Observer, event: &Value) {
        if !Self::push(observer, event) {
            lock(&self.state)
                .observers
                .retain(|known| known != observer);
        }
    }

    /// Closes every page watching the run.
    pub fn close_pages(&self, code: u16) {
        let observers = lock(&self.state).observers.clone();
        for observer in observers {
            observer.close(code);
        }
    }

    /// Sets where the run's operation waits, telling the pages of a change.
    pub fn set_position(&self, place: Option<usize>) {
        let changed = {
            let mut state = lock(&self.state);
            let changed = state.position != place;
            state.position = place;
            changed
        };
        if changed {
            self.publish(&self.snapshot());
        }
    }

    // Frames

    fn submit(&self, frame: Value, authority: Authority, observer: Option<Observer>) -> bool {
        if self.connection().closed {
            if let Some(observer) = &observer {
                self.push_to(
                    observer,
                    &error_terminal(409, "the Team's chat is ending; send again in a moment"),
                );
            }
            return true;
        }
        self.frames
            .try_send(Queued {
                frame,
                authority,
                observer,
            })
            .is_ok()
    }

    async fn run_loop(self: Arc<Self>, mut receiver: mpsc::Receiver<Queued>) {
        while let Some(queued) = receiver.recv().await {
            lock(&self.state).dispatching = true;
            let dispatched = if queued.authority.current() {
                self.run_frame(queued).await
            } else {
                Ok(())
            };
            lock(&self.state).dispatching = false;
            if dispatched.is_err() {
                let run = Arc::clone(&self);
                tokio::spawn(async move { run.end().await });
                return;
            }
        }
    }

    fn work_identity(&self) -> (Option<usize>, Option<u64>, Option<usize>) {
        let connection = self.connection();
        (
            connection
                .active
                .as_ref()
                .map(|turn| Arc::as_ptr(turn) as usize),
            connection.sync_task.as_ref().map(|task| task.id),
            connection
                .lifecycle
                .as_ref()
                .map(|operation| Arc::as_ptr(operation) as usize),
        )
    }

    /// Dispatches one frame; the work it starts, and only that, runs under its authority and is watched afresh.
    async fn run_frame(self: &Arc<Self>, queued: Queued) -> Result<(), Disconnected> {
        let before = self.work_identity();
        let relay = Relay::framed(Arc::clone(self), queued.observer.clone());
        let dispatched = match queued.authority.team() {
            Ok(team) => {
                let ctx = Ctx::new(Arc::clone(&self.app), Arc::clone(self), relay.clone(), team);
                socket::dispatch(&ctx, &queued.frame).await
            }
            Err(_) => Err(socket::DispatchError::Authority),
        };
        relay.dispatched();
        let result = match dispatched {
            Ok(()) => Ok(()),
            Err(socket::DispatchError::Disconnected) => Err(Disconnected),
            Err(socket::DispatchError::Authority) => {
                log("warning", "chat_run_frame_authority_unavailable");
                relay.send(&error_terminal(503, "Supervisor authority is unavailable"));
                Ok(())
            }
        };
        let after = self.work_identity();
        let started = [
            (after.0.is_some(), after.0 != before.0),
            (after.1.is_some(), after.1 != before.1),
            (after.2.is_some(), after.2 != before.2),
        ]
        .iter()
        .any(|(now, changed)| *now && *changed);
        if started {
            let mut state = lock(&self.state);
            state.authority = Some(queued.authority);
            state.live.clear();
            state.started = Some(Instant::now());
            state.position = None;
        }
        result
    }

    // Ending

    /// Forgets an idle run nobody watches; Team keeps any pending request, which a page's sync restores.
    fn retire(&self) {
        registry::forget(&self.app, self);
        if let Some(task) = lock(&self.task).as_ref() {
            task.abort();
        }
    }

    /// Stops the run's work, keeps how its turn ended, and forgets the run (revocation, deletion, reset). The run stays
    /// the Team's until its Team calls and the Stops sent for them have answered.
    pub async fn end(self: Arc<Self>) {
        {
            let mut state = lock(&self.state);
            if state.ending {
                return;
            }
            state.ending = true;
        }
        self.connection().closed = true;
        let task = lock(&self.task).clone();
        if let Some(task) = task {
            task.abort();
            task.wait().await;
        }
        socket::end_run(&self).await;
        registry::forget(&self.app, &self);
    }

    /// Whether every page stopped watching.
    #[must_use]
    pub fn unobserved(&self) -> bool {
        lock(&self.state).observers.is_empty()
    }
}
