//! The chat frames of one Team over the Admin session socket: `shimpz.chat.v7` (ADR-0114).
//!
//! Provider and Assistant secrets stay behind the chat projections; this module dispatches the frames of a Team's run
//! (ADR-0119), admits one mutating operation at a time, keeps Stop responsive on its own bounded lane, and projects
//! controller state onto small, exact public schemas.

pub mod human;
pub mod stop;
pub mod sync;
pub mod turn;

use std::sync::{Arc, MutexGuard};

use team_protocol::payload::canonical_locale;

use super::{
    connection::Connection,
    delivery,
    projection::error_terminal,
    run::{Relay, Run},
    task_resume,
};
use crate::{
    history::store::Store,
    json::{self, Value},
    process::app::App,
    team::transport::Team,
};

/// A protocol refusal closed the run's pages; the run's work ends with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Disconnected;

/// Why a frame's dispatch ended early.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchError {
    /// The current Supervisor authority is unavailable.
    Authority,
    /// The run's pages were closed.
    Disconnected,
}

/// What one frame's dispatch and the work it starts run with: the run, where it writes, and the Team under the
/// frame's authority.
#[derive(Clone)]
pub struct Ctx {
    /// The process.
    pub app: Arc<App>,
    /// The run.
    pub run: Arc<Run>,
    /// Where it writes.
    pub relay: Relay,
    /// Team under the frame's authority.
    pub team: Team,
}

impl Ctx {
    /// A context.
    #[must_use]
    pub const fn new(app: Arc<App>, run: Arc<Run>, relay: Relay, team: Team) -> Self {
        Self {
            app,
            run,
            relay,
            team,
        }
    }

    /// The Team.
    #[must_use]
    pub fn team_id(&self) -> &str {
        &self.run.team_id
    }

    /// The run's chat state.
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.run.connection()
    }

    /// Sends one event.
    pub fn send(&self, event: &Value) {
        self.relay.send(event);
    }

    /// The history store.
    #[must_use]
    pub fn history(&self) -> &Arc<Store> {
        &self.app.domains.history.store
    }

    /// Whether the run ended.
    #[must_use]
    pub fn closed(&self) -> bool {
        self.connection().closed
    }
}

/// A sync frame is exactly `{"type": "sync", "locale": code}`: a restored request renders in that language.
fn sync_locale(frame: &Value) -> Option<String> {
    if !json::has_exactly(frame, &["type", "locale"]) {
        return None;
    }
    canonical_locale(frame.get("locale")?).map(str::to_owned)
}

/// Dispatches one admitted chat frame.
///
/// # Errors
///
/// Returns [`DispatchError`] when the authority is unavailable or the run's pages were closed.
pub async fn dispatch(ctx: &Ctx, frame: &Value) -> Result<(), DispatchError> {
    let kind = json::get_str(frame, "type").unwrap_or_default();
    let stop = json::equal(frame, &json::object(vec![("type", json::text("stop"))]));
    {
        let connection = ctx.connection();
        if stop
            && connection.sync_task.is_none()
            && connection.active.is_none()
            && connection.pending_challenge_id.is_none()
        {
            return Ok(());
        }
        if connection.lifecycle.is_some() {
            drop(connection);
            ctx.send(&error_terminal(
                409,
                "an Assistant lifecycle operation is already active",
            ));
            return Ok(());
        }
        if connection.lifecycle_proposal.is_some() && kind != "chat" {
            drop(connection);
            ctx.send(&error_terminal(
                409,
                "an Assistant lifecycle decision is pending",
            ));
            return Ok(());
        }
    }
    match kind {
        "sync" => {
            if let Some(locale) = sync_locale(frame) {
                sync::dispatch_sync(ctx, &locale);
            } else {
                ctx.send(&error_terminal(400, "unsupported chat frame"));
            }
            Ok(())
        }
        "chat" => turn::dispatch_chat(ctx, frame).await,
        "resume-task" => task_resume::dispatch(ctx, frame).await,
        "stop" if json::has_exactly(frame, &["type"]) => stop::dispatch_stop(ctx).await,
        "human-response" => human::dispatch_human_response(ctx, frame).await,
        _ => {
            ctx.send(&error_terminal(400, "unsupported chat frame"));
            Ok(())
        }
    }
}

/// Stops the run's work in Team; the status of its own Stop when Team did not confirm it.
async fn stop_in_team(
    ctx: &Ctx,
    active: Option<&Arc<super::connection::Turn>>,
    continuing: bool,
) -> Option<u16> {
    stop::close_connection(ctx).await;
    let unanswered = active.is_some_and(|turn| {
        let state = turn.state();
        !state.terminal_sent && state.stop_task.is_none()
    });
    if !continuing && !unanswered {
        return None;
    }
    let response = stop::team_stop(ctx).await;
    super::projection::stop_accepted(&response, ctx.team_id())
        .is_none()
        .then_some(response.reply.status)
}

/// Ends a run's work: stops what it runs in Team, waits until its Team calls and Stops answered, and keeps how its
/// turn ended; a Stop Team did not confirm is never shown as stopped.
pub async fn end_run(run: &Arc<Run>) {
    let app = Arc::clone(run.app());
    let authority = run.authority();
    let team = authority.as_ref().map_or_else(
        || Ok(app.machine_team()),
        crate::supervisor::authority::Authority::team,
    );
    let (active, continuation) = {
        let connection = run.connection();
        (connection.active.clone(), connection.continuation.clone())
    };
    let unfinished = active.as_ref().and_then(|turn| {
        let state = turn.state();
        (!state.terminal_sent)
            .then(|| state.history_id.clone())
            .flatten()
    });
    let relay = Relay::run(Arc::clone(run));
    let unconfirmed = if let Ok(team) = team {
        let ctx = Ctx::new(Arc::clone(&app), Arc::clone(run), relay, team);
        stop_in_team(&ctx, active.as_ref(), continuation.is_some()).await
    } else {
        crate::process::command::log("warning", "chat_run_ended_without_authority");
        let ctx = Ctx::new(Arc::clone(&app), Arc::clone(run), relay, app.machine_team());
        stop::close_connection(&ctx).await;
        Some(503)
    };
    stop::ended(active.as_ref(), continuation.as_ref()).await;
    if let (Some(unfinished), Some(turn)) = (unfinished, active) {
        let unconfirmed = unconfirmed.or(turn.state().stop_unconfirmed);
        let ending = unconfirmed.map_or_else(
            || json::object(vec![("type", json::text("stopped"))]),
            |status| stop::unstopped(Some(status)),
        );
        let _ = delivery::history_terminal(
            &app,
            &run.team_id,
            Some(&unfinished),
            &ending,
            unconfirmed.is_none(),
            None,
        )
        .await;
        run.publish(&ending);
    }
}
