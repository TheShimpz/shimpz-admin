//! Stop: a waiting operation leaves at once; a running one is stopped in Team on its own bounded lane, and its turn
//! ends as stopped only when Team confirmed it. Ending a run stops its work the same way.

use std::{sync::Arc, time::Duration};

use super::{Ctx, DispatchError};
use crate::{
    chat::{
        connection::{Pending, TaskHandle, Turn, TurnState},
        delivery::terminal,
        lifecycle,
        local::{Answer, turn as local_turn},
        projection::{error_terminal, stop_accepted},
    },
    history::delivery,
    json::{self, Value},
    lanes::Ended,
};

/// How long a turn's delivery waits for the Stop sent for it.
pub const STOP_RESULT_WAIT: Duration = Duration::from_secs(15);

fn stopped() -> Value {
    json::object(vec![("type", json::text("stopped"))])
}

/// Asks Team to stop the Team's chat on the Stop lane; Stop fails closed as turn delivery does.
pub async fn team_stop(ctx: &Ctx) -> Answer {
    let (team, team_id) = (ctx.team.clone(), ctx.team_id().to_owned());
    let lanes = &ctx.app.domains.chat.lanes;
    let Ok(job) = lanes
        .stop
        .submit(async move { local_turn::stop(&team, &team_id).await })
    else {
        return Answer::raw(429, json::empty());
    };
    match job.wait().await {
        Ended::Done(Ok(answer)) => answer,
        _ => Answer::raw(502, json::empty()),
    }
}

/// The error a Stop Team did not confirm ends the turn with.
#[must_use]
pub fn unstopped(status: Option<u16>) -> Value {
    error_terminal(status.unwrap_or(502), "chat turn could not be stopped")
}

/// Ends the active turn with `event`.
pub async fn finish_active_turn(ctx: &Ctx, turn: &Arc<Turn>, event: &Value) {
    terminal::turn(ctx, turn, event, false).await;
    ctx.connection().release(turn);
}

async fn finish_cancelled_turn(ctx: Ctx, turn: Arc<Turn>) {
    terminal::turn(&ctx, &turn, &stopped(), false).await;
    ctx.connection().release(&turn);
}

async fn run_stop(ctx: Ctx, turn: Arc<Turn>, emit: bool) {
    let response = team_stop(&ctx).await;
    let accepted = stop_accepted(&response, ctx.team_id());
    if accepted.is_none() {
        turn.state().stop_unconfirmed = Some(response.reply.status);
    }
    let (operation, unconfirmed, sent) = {
        let state = turn.state();
        (state.operation, state.stop_unconfirmed, state.terminal_sent)
    };
    if emit && !ctx.closed() && !sent {
        match accepted {
            Some(true) => {
                ctx.connection().forget_challenge();
                terminal::turn(&ctx, &turn, &stopped(), true).await;
            }
            None => {
                terminal::turn(&ctx, &turn, &unstopped(unconfirmed), false).await;
            }
            Some(false) if operation == "pending-stop" => {
                terminal::turn(
                    &ctx,
                    &turn,
                    &error_terminal(409, "no active chat turn"),
                    true,
                )
                .await;
            }
            Some(false) => {}
        }
    }
    let mut state = turn.state();
    state.stop_task = None;
    if state.operation == "pending-stop" && state.terminal_sent {
        drop(state);
        ctx.connection().release(&turn);
    }
}

fn spawn_finish(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    state: &mut TurnState,
    emit: bool,
) -> Option<TaskHandle> {
    if emit && !ctx.closed() {
        let (ctx, turn) = (ctx.clone(), Arc::clone(turn));
        state.stop_task = Some(TaskHandle::spawn(move |_| finish_cancelled_turn(ctx, turn)));
    }
    state.stop_task.clone()
}

/// Requests one Stop of `turn`; the task that ends it, if any.
pub fn request_stop(ctx: &Ctx, turn: &Arc<Turn>, emit: bool) -> Option<TaskHandle> {
    let pending_challenge = ctx.connection().pending_challenge_id.is_some();
    let mut state = turn.state();
    if state.stop_requested {
        return state.stop_task.clone();
    }
    state.stop_requested = true;
    if state.operation == "queued" {
        if let Some(delivery) = &state.delivery {
            delivery.abort();
        }
        return spawn_finish(ctx, turn, &mut state, emit);
    }
    if let Some(stop) = &state.lifecycle_stop {
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if state.operation == "assistant-plan" {
            return None;
        }
        if let Some(future) = &state.future {
            let _ = future.cancel();
        }
        return spawn_finish(ctx, turn, &mut state, emit);
    }
    let cancelled = state.future.as_ref().is_some_and(|future| future.cancel());
    if cancelled && !pending_challenge {
        return spawn_finish(ctx, turn, &mut state, emit);
    }
    let (stop_ctx, stop_turn) = (ctx.clone(), Arc::clone(turn));
    let task = TaskHandle::spawn(move |_| run_stop(stop_ctx, stop_turn, emit));
    state.stop_task = Some(task.clone());
    Some(task)
}

/// A Stop of a paused turn: it becomes the active turn, bound to the Team's resumable history turn.
async fn pending_stop(ctx: &Ctx) -> Option<Arc<Turn>> {
    let pending = ctx.connection().pending_history_id.clone();
    let history_id = if let Some(history_id) = pending {
        history_id
    } else {
        let store = Arc::clone(ctx.history());
        let Ok(history_id) = delivery::resume(&store, ctx.team_id()).await else {
            ctx.send(&error_terminal(503, "Admin chat history is unavailable"));
            return None;
        };
        history_id
    };
    let turn = Turn::new(TurnState {
        operation: "pending-stop",
        history_id: Some(history_id),
        ..TurnState::default()
    });
    ctx.connection().active = Some(Arc::clone(&turn));
    Some(turn)
}

/// A page's Stop.
///
/// # Errors
///
/// Returns [`DispatchError::Disconnected`] when a Stop crossed a running continuation, which closes the pages.
pub async fn dispatch_stop(ctx: &Ctx) -> Result<(), DispatchError> {
    if ctx.connection().sync_task.is_some() {
        let refusal = error_terminal(409, "a chat continuation is already active");
        if terminal::resumed(ctx, &refusal, false).await {
            ctx.connection().closed = true;
            ctx.relay.close(1008);
            return Err(DispatchError::Disconnected);
        }
        return Ok(());
    }
    let existing = ctx.connection().active.clone();
    let active = if let Some(active) = existing {
        active
    } else if let Some(turn) = pending_stop(ctx).await {
        turn
    } else {
        return Ok(());
    };
    request_stop(ctx, &active, true);
    Ok(())
}

/// Stops observing the run's work: its sync ends, its active turn is stopped in Team, and its delivery ends.
pub async fn close_connection(ctx: &Ctx) {
    let (sync_task, active) = {
        let mut connection = ctx.connection();
        connection.closed = true;
        (connection.sync_task.clone(), connection.active.clone())
    };
    if let Some(task) = sync_task {
        task.abort();
        task.wait().await;
    }
    if let Some(active) = active {
        let (mut stop_task, running, delivery) = {
            let state = active.state();
            let running = state
                .future
                .as_ref()
                .is_some_and(|future| !future.is_finished());
            (state.stop_task.clone(), running, state.delivery.clone())
        };
        if running {
            stop_task = request_stop(ctx, &active, false);
        }
        if let Some(stop_task) = stop_task {
            let _ = tokio::time::timeout(STOP_RESULT_WAIT, stop_task.wait()).await;
        }
        if let Some(delivery) = delivery {
            delivery.abort();
            delivery.wait().await;
        }
    }
    lifecycle::close(ctx).await;
}

/// Waits until a run's Team call, its continuation, and the Stop sent for them have all ended.
pub async fn ended(active: Option<&Arc<Turn>>, continuation: Option<&Arc<dyn Pending>>) {
    let (future, stop_task) = active.map_or((None, None), |turn| {
        let state = turn.state();
        (state.future.clone(), state.stop_task.clone())
    });
    let future_ended = async {
        if let Some(future) = future {
            future.ended().await;
        }
    };
    let stop_ended = async {
        if let Some(task) = stop_task {
            task.wait().await;
        }
    };
    let continuation_ended = async {
        if let Some(continuation) = continuation {
            continuation.ended().await;
        }
    };
    tokio::join!(future_ended, stop_ended, continuation_ended);
}
