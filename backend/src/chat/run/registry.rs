//! Each Team's chat run in this Admin process (ADR-0119): an Admin restart ends them all, never replaying any. Runs
//! whose authority ended are ended; idle runs nobody watches are forgotten.

use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use super::{Observer, Run};
use crate::{
    app::App,
    authority::Authority,
    json::Value,
    session::socket::{Channel, Socket},
    sync::lock,
};

/// How often a run's authority and idleness are checked again.
pub const SWEEP: Duration = Duration::from_secs(30);

/// The Team's run, created on first need.
#[must_use]
pub fn run_for(app: &Arc<App>, team_id: &str) -> Arc<Run> {
    let state = &app.domains.chat;
    listen(app);
    let mut runs = lock(&state.runs);
    if let Some(run) = runs.get(team_id) {
        return Arc::clone(run);
    }
    let run = Run::start(app, team_id);
    runs.insert(team_id.to_owned(), Arc::clone(&run));
    drop(runs);
    start_sweep(app);
    run
}

/// Forgets `run` when it is still its Team's.
pub(super) fn forget(app: &App, run: &Run) {
    let mut runs = lock(&app.domains.chat.runs);
    if runs
        .get(&run.team_id)
        .is_some_and(|known| std::ptr::eq(Arc::as_ptr(known), run))
    {
        runs.remove(&run.team_id);
    }
}

fn end_apart(run: Arc<Run>) {
    tokio::spawn(run.end());
}

/// Ends one Team's run, or every run: its Team was deleted, or the Space reset.
pub fn end_runs(app: &App, team_id: Option<&str>) {
    let runs: Vec<Arc<Run>> = lock(&app.domains.chat.runs)
        .iter()
        .filter(|(key, _)| team_id.is_none_or(|team_id| key.as_str() == team_id))
        .map(|(_, run)| Arc::clone(run))
        .collect();
    runs.into_iter().for_each(end_apart);
}

/// Ends the work each ended session authorized.
fn sessions_ended(app: &App, sessions: Option<&HashSet<String>>) {
    let runs: Vec<Arc<Run>> = lock(&app.domains.chat.runs).values().cloned().collect();
    for run in runs {
        let ended = run.authority().is_some_and(|authority| {
            sessions.is_none_or(|sessions| sessions.contains(&authority.session))
        });
        if ended && run.busy() {
            end_apart(run);
        }
    }
}

fn listen(app: &Arc<App>) {
    if app.domains.chat.listening.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let weak = Arc::downgrade(app);
    app.sessions.listen(Arc::new(move |sessions| {
        let Some(app) = weak.upgrade() else {
            return;
        };
        let _entered = runtime.enter();
        sessions_ended(&app, sessions);
    }));
}

fn start_sweep(app: &Arc<App>) {
    let mut sweep = lock(&app.domains.chat.sweep);
    if sweep.as_ref().is_some_and(|task| !task.is_finished()) {
        return;
    }
    let weak = Arc::downgrade(app);
    *sweep = Some(tokio::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP).await;
            let Some(app) = weak.upgrade() else {
                return;
            };
            let runs: Vec<Arc<Run>> = lock(&app.domains.chat.runs).values().cloned().collect();
            if runs.is_empty() {
                return;
            }
            for run in runs {
                if run.busy() {
                    if run
                        .authority()
                        .is_some_and(|authority| !authority.current())
                    {
                        end_apart(run);
                    }
                } else if run.unobserved() {
                    run.retire();
                }
            }
        }
    }));
}

/// One page watching one Team's chat run over its session socket (ADR-0114, ADR-0119).
struct RunChannel {
    app: Arc<App>,
    team_id: String,
    observer: Observer,
    authority: Authority,
    locale: String,
}

impl Channel for RunChannel {
    fn start(&self) {
        run_for(&self.app, &self.team_id).attach(
            &self.observer,
            self.authority.clone(),
            &self.locale,
        );
    }

    fn submit(&self, frame: Value) -> bool {
        let run = run_for(&self.app, &self.team_id);
        if !run.connection().closed {
            run.observe(&self.observer);
        }
        run.submit(frame, self.authority.clone(), Some(self.observer.clone()))
    }

    fn leave(&self) {
        let run = lock(&self.app.domains.chat.runs)
            .get(&self.team_id)
            .cloned();
        if let Some(run) = run {
            run.detach(&self.observer);
        }
    }
}

/// A Team's chat channel on `socket`; its frames run under the authority the socket holds.
#[must_use]
pub fn channel(socket: &Arc<Socket>, team_id: &str, locale: &str) -> Arc<dyn Channel> {
    Arc::new(RunChannel {
        app: Arc::clone(socket.app()),
        team_id: team_id.to_owned(),
        observer: Observer::new(socket, team_id),
        authority: socket.authority(),
        locale: locale.to_owned(),
    })
}
