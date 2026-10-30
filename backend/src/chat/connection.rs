//! The in-memory state of one Team's chat run: its active turn, its pending challenge, its continuation, its lifecycle
//! proposal and operation, and the receipt of the progress its pages were shown.

use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use tokio::sync::watch;

use super::{
    assistants::proposal::{AssistantReference, UninstallProposal},
    gate::Held,
};
use crate::{
    history::context::Entry,
    json::{self, Value},
    lanes::Job,
    sync::lock,
};

/// A started job a Stop may cancel while it waits for a worker, and whose end a run awaits before it lets its Team go.
pub trait Pending: Send + Sync {
    /// Cancels it if it has not started; whether it is cancelled.
    fn cancel(&self) -> bool;
    /// Whether it ended.
    fn is_finished(&self) -> bool;
    /// Waits until it ended.
    fn ended(&self) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

impl<T: Clone + Send + Sync + 'static> Pending for Job<T> {
    fn cancel(&self) -> bool {
        Job::cancel(self)
    }

    fn is_finished(&self) -> bool {
        Job::is_finished(self)
    }

    fn ended(&self) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let job = self.clone();
        Box::pin(async move {
            job.wait().await;
        })
    }
}

static TASKS: AtomicU64 = AtomicU64::new(1);

/// One spawned piece of a run's work: abortable, awaitable by anyone, and known by its id.
#[derive(Clone)]
pub struct TaskHandle {
    /// Its id.
    pub id: u64,
    abort: tokio::task::AbortHandle,
    done: watch::Receiver<bool>,
}

struct Finished(watch::Sender<bool>);

impl Drop for Finished {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

impl TaskHandle {
    /// Spawns `work`, which learns its own id.
    pub fn spawn<F, W>(work: W) -> Self
    where
        W: FnOnce(u64) -> F,
        F: Future<Output = ()> + Send + 'static,
    {
        let id = TASKS.fetch_add(1, Ordering::Relaxed);
        let (sender, done) = watch::channel(false);
        let future = work(id);
        let handle = tokio::spawn(async move {
            let _finished = Finished(sender);
            future.await;
        });
        Self {
            id,
            abort: handle.abort_handle(),
            done,
        }
    }

    /// Stops it at its next await.
    pub fn abort(&self) {
        self.abort.abort();
    }

    /// Whether it ended.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        *self.done.borrow()
    }

    /// Waits until it ended.
    pub async fn wait(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|finished| *finished).await;
    }
}

/// One turn's mutable state.
#[derive(Default)]
pub struct TurnState {
    /// The job it waits on.
    pub future: Option<Arc<dyn Pending>>,
    /// What it does now: `queued`, `assistant-route`, `assistant-plan`, `chat`, or `pending-stop`.
    pub operation: &'static str,
    /// Its delivery.
    pub delivery: Option<TaskHandle>,
    /// The Stop sent for it.
    pub stop_task: Option<TaskHandle>,
    /// Whether a Stop was requested.
    pub stop_requested: bool,
    /// Whether its terminal was sent.
    pub terminal_sent: bool,
    /// Its lifecycle guidance and proposals' interface language (ADR-0090).
    pub locale: Option<String>,
    /// Stops its Assistant plan between items.
    pub lifecycle_stop: Option<Arc<AtomicBool>>,
    /// Its history turn.
    pub history_id: Option<String>,
    /// The committed conversation before its user row.
    pub conversation: Vec<Entry>,
    /// The identity Team binds a Routine change of this turn to (ADR-0092).
    pub request: Option<Value>,
    /// Its hold on the Space's chat gate while it runs (ADR-0119).
    pub slot: Option<Arc<tokio::sync::Mutex<Held>>>,
    /// The status of a Stop Team did not confirm.
    pub stop_unconfirmed: Option<u16>,
}

/// One turn.
#[derive(Default)]
pub struct Turn(Mutex<TurnState>);

impl Turn {
    /// A turn of this state.
    #[must_use]
    pub fn new(state: TurnState) -> Arc<Self> {
        Arc::new(Self(Mutex::new(state)))
    }

    /// Its state.
    pub fn state(&self) -> MutexGuard<'_, TurnState> {
        lock(&self.0)
    }
}

/// The Team progress a run delivered of one logical turn, which its reply keeps (ADR-0082).
#[derive(Clone, Debug, Default)]
pub struct Receipt {
    /// The history turn it belongs to.
    pub turn_id: Option<String>,
    /// How many deliveries it began.
    pub deliveries: i64,
    /// The events.
    pub events: Vec<Value>,
    /// Which collection the events belong to: a delivery begun for an earlier one records nothing more.
    pub generation: u64,
}

/// An approved uninstall Team executes now.
pub struct Operation {
    /// The proposal.
    pub proposal: UninstallProposal,
    /// The job.
    pub future: Arc<dyn Pending>,
    /// Its delivery.
    pub delivery: Mutex<Option<TaskHandle>>,
    /// Its history turn.
    pub history_id: Option<String>,
}

/// The chat state of one Team's run.
#[derive(Default)]
pub struct Connection {
    /// The active turn.
    pub active: Option<Arc<Turn>>,
    /// The pending challenge.
    pub pending_challenge_id: Option<String>,
    /// `integration` or `human`.
    pub pending_challenge_type: Option<&'static str>,
    /// The pending human request.
    pub pending_human_request: Option<Value>,
    /// The running sync or continuation delivery.
    pub sync_task: Option<TaskHandle>,
    /// Whether that delivery sent its terminal.
    pub sync_terminal_sent: bool,
    /// A continuation Team executes now; ending the run stops it there too (ADR-0119).
    pub continuation: Option<Arc<dyn Pending>>,
    /// The uninstall proposal awaiting its decision.
    pub lifecycle_proposal: Option<UninstallProposal>,
    /// The approved uninstall.
    pub lifecycle: Option<Arc<Operation>>,
    /// The Assistant a recent lifecycle turn named.
    pub assistant_reference: Option<AssistantReference>,
    /// Whether the run ended.
    pub closed: bool,
    /// The user row this run admitted last.
    pub admitted_history_id: Option<String>,
    /// The history turn a pending challenge belongs to.
    pub pending_history_id: Option<String>,
    /// The receipt being collected.
    pub receipt: Receipt,
}

impl Connection {
    /// Remembers the challenge a page now answers.
    pub fn remember_challenge(&mut self, challenge: &Value, kind: &'static str) {
        self.pending_challenge_id = json::get_str(challenge, "challenge_id").map(str::to_owned);
        self.pending_challenge_type = Some(kind);
        self.pending_human_request = if kind == "human" {
            challenge
                .get("request")
                .filter(|request| json::members(request).is_some())
                .cloned()
        } else {
            None
        };
    }

    /// Forgets the pending challenge.
    pub fn forget_challenge(&mut self) {
        self.pending_challenge_id = None;
        self.pending_challenge_type = None;
        self.pending_human_request = None;
    }

    /// Hands the user row this run admitted to the turn that answers it, exactly once.
    pub fn take_history_id(&mut self) -> Option<String> {
        self.admitted_history_id.take()
    }

    /// Whether `turn` is the active turn.
    #[must_use]
    pub fn is_active(&self, turn: &Arc<Turn>) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, turn))
    }

    /// Forgets `turn` when it is still the active one.
    pub fn release(&mut self, turn: &Arc<Turn>) {
        if self.is_active(turn) {
            self.active = None;
        }
    }
}

/// A fresh identity for one send (ADR-0092): its issue instant and a nonce. A send is never resent as itself.
#[must_use]
pub fn request_identity(now: i64) -> Value {
    json::object(vec![
        ("issued_at", json::int(now)),
        ("nonce", json::text(crate::random::hex(16))),
    ])
}
