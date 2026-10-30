//! Admin's Routine scheduler (ADR-0086): one task claims due runs onto a lane of two workers.
//!
//! Every tick, with jitter, it delivers notices, then reserves a free lane slot before each claim, so a lease is never
//! taken for a run no worker can start, and it claims until every slot is busy or Team has nothing more to start. At
//! most one worker holds a long run: a claim offers to take a long run only while that one long slot is free. Team
//! enforces every lease and deadline itself. A tick comes at the latest every interval; Team's next-due hint and a
//! finished run wake it sooner.

use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::{delivery, team};
use crate::{
    json::{self, Value},
    process::app::App,
    process::command::log,
    supervisor::identity::{self, LocalIdentity},
    sync::lock,
};

/// The reconciliation interval.
pub const INTERVAL: Duration = Duration::from_secs(30);
/// The most jitter added to it.
pub const JITTER_MS: u64 = 5_000;
/// The earliest a hint or a finished run wakes the next tick.
pub const MIN_WAKE_MS: i64 = 1_000;
/// The run workers.
pub const WORKERS: usize = 2;

/// The scheduler's wake and its lane slots.
pub struct Scheduler {
    wake: Notify,
    due_at_ms: Mutex<Option<i64>>,
    slots: Arc<Semaphore>,
    long: Arc<Semaphore>,
}

impl Scheduler {
    /// A scheduler whose first tick comes at once: a run may already be due.
    #[must_use]
    pub fn new(now_ms: i64) -> Self {
        Self {
            wake: Notify::new(),
            due_at_ms: Mutex::new(Some(now_ms)),
            slots: Arc::new(Semaphore::new(WORKERS)),
            long: Arc::new(Semaphore::new(1)),
        }
    }

    /// Claim soon: a person's answer or a confirmed card made a Routine due now.
    pub fn wake(&self, now_ms: i64) {
        *lock(&self.due_at_ms) = Some(now_ms);
        self.wake.notify_one();
    }

    /// How long until the next tick: the interval with jitter, or sooner for a hinted due run.
    #[must_use]
    pub fn delay(&self, now_ms: i64) -> Duration {
        let mut delay = i64::try_from(INTERVAL.as_millis()).unwrap_or(30_000)
            + i64::try_from(crate::random::below(JITTER_MS + 1)).unwrap_or(0);
        if let Some(due) = *lock(&self.due_at_ms) {
            delay = delay.min(MIN_WAKE_MS.max(due - now_ms));
        }
        Duration::from_millis(u64::try_from(delay).unwrap_or(0))
    }
}

/// Starts the scheduler for the process's life.
pub fn start(app: &Arc<App>) {
    tokio::spawn(run(Arc::downgrade(app)));
}

async fn run(app: Weak<App>) {
    loop {
        let Some(app) = app.upgrade() else {
            return;
        };
        let scheduler = &app.domains.routines.scheduler;
        let delay = scheduler.delay(app.clock.now_ms());
        tokio::select! {
            () = scheduler.wake.notified() => {}
            () = tokio::time::sleep(delay) => {}
        }
        tick(&app).await;
    }
}

/// Delivers notices, then starts a due run in every free slot; a failure waits for the next tick.
pub async fn tick(app: &Arc<App>) {
    if delivery::deliver(app).await.is_err() {
        log("warning", "routine_notice_delivery_failed");
    }
    if start_runs(app).await.is_err() {
        log("warning", "routine_claim_failed");
    }
}

/// A claim or the identity it is taken for failed.
#[derive(Clone, Copy, Debug)]
struct ClaimFailed;

fn routine_identity(app: &App) -> Result<LocalIdentity, ClaimFailed> {
    let identity = app
        .store
        .local_routine_identity()
        .map_err(|_| ClaimFailed)?;
    identity::materialize(
        &app.config.routine_key_file(),
        app.config.key_group,
        &identity,
    )
    .map_err(|_| ClaimFailed)?;
    Ok(identity)
}

/// Fills every free lane slot with a due run, one claim per slot, until Team has nothing more to start.
async fn start_runs(app: &Arc<App>) -> Result<(), ClaimFailed> {
    let scheduler = &app.domains.routines.scheduler;
    let Ok(mut slot) = Arc::clone(&scheduler.slots).try_acquire_owned() else {
        return Ok(());
    };
    let identity = routine_identity(app)?;
    *lock(&scheduler.due_at_ms) = None;
    loop {
        let Some((claimed, long)) = claim(app).await? else {
            return Ok(());
        };
        let team_id = json::get_str(&claimed, "team_id")
            .unwrap_or_default()
            .to_owned();
        tokio::spawn(run_claimed(
            Arc::clone(app),
            claimed,
            identity.clone(),
            (slot, long),
        ));
        app.topics.team_changed(&team_id, &["routines"]);
        match Arc::clone(&scheduler.slots).try_acquire_owned() {
            Ok(next) => slot = next,
            Err(_) => return Ok(()),
        }
    }
}

/// Claims one run, offering a long one only while the long slot is free; the long slot when the run keeps it.
async fn claim(app: &App) -> Result<Option<(Value, Option<OwnedSemaphorePermit>)>, ClaimFailed> {
    let scheduler = &app.domains.routines.scheduler;
    let reserved = Arc::clone(&scheduler.long).try_acquire_owned().ok();
    let answer = team::claim(&app.machine_team(), reserved.is_some())
        .await
        .map_err(|_| ClaimFailed)?;
    let claimed = answer.get("run").cloned().unwrap_or(Value::Null);
    if claimed == Value::Null {
        *lock(&scheduler.due_at_ms) = answer
            .get("next_due_at")
            .and_then(json::as_int)
            .map(|seconds| seconds.saturating_mul(1000));
        return Ok(None);
    }
    if !team::is_long(&claimed) {
        return Ok(Some((claimed, None)));
    }
    match reserved {
        Some(long) => Ok(Some((claimed, Some(long)))),
        None => Err(ClaimFailed),
    }
}

async fn run_claimed(
    app: Arc<App>,
    claimed: Value,
    identity: LocalIdentity,
    permits: (OwnedSemaphorePermit, Option<OwnedSemaphorePermit>),
) {
    match team::run(&app.machine_team(), &claimed, identity).await {
        Ok(_) => log("info", "routine_run_ended"),
        Err(_) => log("warning", "routine_run_segment_failed"),
    }
    drop(permits);
    if let Some(team_id) = json::get_str(&claimed, "team_id") {
        app.topics.team_changed(team_id, &["routines"]);
    }
    app.domains.routines.scheduler.wake(app.clock.now_ms());
}
