//! A sent chat message: its admission into the Team's history, its route under the Space's chat gate, and the Team
//! turn it continues into, its progress delivered before its terminal.

use std::sync::Arc;

use super::{Ctx, DispatchError, stop::finish_active_turn};
use crate::chat::durable::{self, reattach};
use crate::team::bridge;

/// How long a turn whose Team could not be reached waits before it is sent again.
const RETRY: std::time::Duration = std::time::Duration::from_secs(2);
use crate::{
    chat::{
        assistants::route::Context,
        connection::{Pending, TaskHandle, Turn, request_identity},
        delivery::{
            challenge, gated,
            progress::{self, Watched},
            route as route_delivery, terminal,
        },
        gate::Refused,
        lifecycle,
        local::{
            Answer,
            turn::{self as local_turn, Submission},
        },
        payloads::{self, CHAT_PAYLOAD_FIELDS},
        projection::{error_terminal, first_challenge, turn_terminal},
    },
    fault::Fault,
    history::{
        HistoryError,
        delivery::{self as history, AdmitError},
    },
    json::{self, Number, Value},
    lanes::Job,
    process::command::log,
};

fn stopped() -> Value {
    json::object(vec![("type", json::text("stopped"))])
}

/// The Team's answer to the submitted turn, its progress delivered first; a failure is an answer no page is shown.
async fn turn_response(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    job: &Job<Result<Answer, Fault>>,
    queue: &mut progress::ProgressQueue,
) -> Answer {
    let history_id = turn.state().history_id.clone();
    let recording = progress::receipt_delivery(&mut ctx.connection(), history_id.as_deref(), true);
    let run = Arc::clone(&ctx.run);
    let watched = Watched {
        inactive: || ctx.closed() || turn.state().terminal_sent,
        record: |frame: &Value| progress::record(&mut run.connection(), recording, frame),
        progress: queue,
    };
    match progress::await_result(ctx, job, watched).await {
        Some(Ok(answer)) => answer,
        Some(Err(Fault::TeamRequest(_))) => Answer::raw(400, json::empty()),
        _ => Answer::raw(502, json::empty()),
    }
}

/// The ending a page is shown of Team's answer: an invalid challenge fails the turn.
fn ending(answer: &Answer, team_id: &str) -> Value {
    let challenged = answer.reply.status == 428
        || matches!(
            answer.reply.get_str("status"),
            Some("human-required" | "integrations-required")
        );
    if challenged {
        error_terminal(502, "the Assistant challenge was invalid")
    } else {
        turn_terminal(answer, team_id)
    }
}

/// Delivers the Team's answer: a challenge pauses the turn; anything else ends it. Team is told it was delivered only
/// once the history committed it; otherwise the sweep settles it (ADR-0125).
async fn deliver_turn(ctx: &Ctx, turn: &Arc<Turn>, answer: &Answer) {
    let (requested, stop_task) = {
        let state = turn.state();
        (state.stop_requested, state.stop_task.clone())
    };
    if requested && let Some(stop_task) = stop_task {
        let _ = tokio::time::timeout(super::stop::STOP_RESULT_WAIT, stop_task.wait()).await;
    }
    let committed = if ctx.closed() || turn.state().terminal_sent {
        false
    } else if let Some((event, kind)) = first_challenge(answer, ctx.team_id()) {
        ctx.connection().lifecycle_proposal = None;
        challenge::deliver(ctx, turn, &event, kind).await
    } else {
        let event = ending(answer, ctx.team_id());
        if json::get_str(&event, "type") == Some("done") {
            ctx.connection().forget_challenge();
        }
        terminal::turn(ctx, turn, &event, false).await
    };
    settled(ctx, turn, committed);
    ctx.connection().release(turn);
}

/// Records the turn before Team is sent it, owned by this run until it is settled (ADR-0125); the ending it fails
/// with when it cannot be kept.
fn recorded(ctx: &Ctx, turn: &Arc<Turn>, submission: &Submission) -> Result<(), Value> {
    let unavailable = || error_terminal(503, "Admin could not keep the chat turn");
    let Ok(body) = submission.body() else {
        // Team refuses it before running anything: nothing to keep.
        return Ok(());
    };
    let request = json::get(&body, "request");
    let (Some(authority), Some(nonce), Some(Value::Number(Number::Int(issued_at)))) = (
        ctx.run.authority(),
        request.and_then(|request| json::get_str(request, "nonce")),
        request.and_then(|request| json::get(request, "issued_at")),
    ) else {
        return Err(unavailable());
    };
    let grant = durable::grant_of(&ctx.app, &authority).ok_or_else(unavailable)?;
    if grant.expires_at.min(grant.idle_until) < issued_at.saturating_add(durable::GRANT_SECONDS) {
        // Team holds a turn for a bounded time from its send: one that would outlive its session is not sent.
        return Err(error_terminal(
            401,
            "this session ends soon: sign in again to send",
        ));
    }
    let pending = durable::Pending {
        team_id: ctx.team_id().to_owned(),
        history_id: turn.state().history_id.clone(),
        nonce: nonce.to_owned(),
        body: body.clone(),
        grant,
        revoked: false,
    };
    ctx.app
        .domains
        .chat
        .turns
        .record(pending)
        .map_err(|_| unavailable())
}

/// Tells Team the turn was delivered once its ending is `committed`; a turn whose ending is not committed, or Team
/// could not be told of, is left to the sweep.
fn settled(ctx: &Ctx, turn: &Arc<Turn>, committed: bool) {
    let Some(request) = turn.state().request.clone() else {
        return;
    };
    let Some(nonce) = json::get_str(&request, "nonce").map(str::to_owned) else {
        return;
    };
    if !committed {
        ctx.app.domains.chat.turns.release(ctx.team_id(), &nonce);
        return;
    }
    let (app, team, team_id) = (
        Arc::clone(&ctx.app),
        ctx.team.clone(),
        ctx.team_id().to_owned(),
    );
    tokio::spawn(async move {
        let turns = &app.domains.chat.turns;
        let response = bridge::settle_chat(&team, &team_id, &request, false).await;
        if response.is_ok_and(|response| response.success() || response.status == 409) {
            let _ = turns.remove(&team_id, &nonce);
        } else {
            turns.release(&team_id, &nonce);
        }
    });
}

fn submit_team_turn(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
) -> Result<(Job<Result<Answer, Fault>>, progress::ProgressQueue), Value> {
    let (queue, report) = progress::channel();
    let (conversation, request) = {
        let state = turn.state();
        (
            state.conversation.clone(),
            state.request.clone().unwrap_or(Value::Null),
        )
    };
    let submission = Submission::Turn {
        payload: payload.clone(),
        conversation,
        request,
    };
    recorded(ctx, turn, &submission)?;
    let (app, team, team_id) = (
        Arc::clone(&ctx.app),
        ctx.team.clone(),
        ctx.team_id().to_owned(),
    );
    let job = ctx
        .app
        .domains
        .chat
        .lanes
        .turn
        .submit(async move { local_turn::submit(&app, &team, &team_id, submission, &report).await })
        .map_err(|_| error_terminal(429, "local chat capacity reached"))?;
    Ok((job, queue))
}

/// Continues a turn into its Team turn; a Space Team found busy waits at the head of the gate's queue and asks again.
///
/// # Errors
///
/// Returns [`Refused`] when the gate let the turn not start again.
pub async fn continue_team_turn(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
) -> Result<(), Refused> {
    if turn.state().stop_requested || ctx.closed() {
        finish_active_turn(ctx, turn, &stopped()).await;
        return Ok(());
    }
    let answer = loop {
        let (job, mut queue) = match submit_team_turn(ctx, turn, payload) {
            Ok(submitted) => submitted,
            Err(refusal) => {
                finish_active_turn(ctx, turn, &refusal).await;
                return Ok(());
            }
        };
        let slot = {
            let mut state = turn.state();
            state.future = Some(Arc::new(job.clone()) as Arc<dyn Pending>);
            state.operation = "chat";
            state.lifecycle_stop = None;
            state.slot.clone()
        };
        let answer = turn_response(ctx, turn, &job, &mut queue).await;
        let current = ctx
            .run
            .authority()
            .is_some_and(|authority| authority.current());
        if reattach::unreached(&answer.reply)
            && current
            && !turn.state().stop_requested
            && !ctx.closed()
        {
            // Team is down or lost the turn's run: the same send attaches to it, resumes it, or receives its ending.
            tokio::time::sleep(RETRY).await;
            continue;
        }
        let Some(slot) = slot.filter(|_| {
            gated::space_busy(Some(&answer)) && !turn.state().stop_requested && !ctx.closed()
        }) else {
            break answer;
        };
        turn.state().operation = "queued";
        slot.lock().await.busy().await?;
        gated::authorized(ctx)?;
    };
    deliver_turn(ctx, turn, &answer).await;
    Ok(())
}

/// The admitted chat payload and its send's identity, or `None` after an error terminal.
async fn admit(ctx: &Ctx, frame: &Value) -> Result<Option<(Value, Value)>, DispatchError> {
    let mut fields = vec!["type"];
    fields.extend(CHAT_PAYLOAD_FIELDS);
    if !json::has_exactly(frame, &fields) {
        ctx.send(&error_terminal(
            400,
            "chat frame requires message, files, assistant_ids, locale, timezone, and refine",
        ));
        return Ok(None);
    }
    let Ok(payload) = payloads::chat_payload(&json::without(frame, "type")) else {
        ctx.send(&error_terminal(400, "invalid chat request"));
        return Ok(None);
    };
    {
        let connection = ctx.connection();
        if connection.active.is_some()
            || connection.sync_task.is_some()
            || connection.lifecycle.is_some()
        {
            drop(connection);
            ctx.send(&error_terminal(409, "a chat turn is already active"));
            return Ok(None);
        }
        if connection.pending_challenge_id.is_some() {
            drop(connection);
            ctx.send(&error_terminal(
                409,
                "an Assistant challenge must be resolved before another turn",
            ));
            return Ok(None);
        }
    }
    let identity = request_identity(ctx.app.clock.now_secs());
    let reused = lifecycle::reuses_history(&ctx.connection(), &payload);
    if reused || commit_user_history(ctx, &payload).await? {
        Ok(Some((payload, identity)))
    } else {
        Ok(None)
    }
}

async fn commit_user_history(ctx: &Ctx, payload: &Value) -> Result<bool, DispatchError> {
    let message = payload.get("message").cloned().unwrap_or(Value::Null);
    let files: Vec<String> = payload
        .get("files")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(json::as_str)
        .map(str::to_owned)
        .collect();
    match history::admit(&ctx.app, &ctx.team, ctx.team_id(), &message, &files).await {
        Ok(history_id) => {
            ctx.connection().admitted_history_id = Some(history_id);
            Ok(true)
        }
        Err(AdmitError::Saturated) => {
            ctx.send(&error_terminal(429, "Admin chat history capacity reached"));
            Ok(false)
        }
        Err(AdmitError::SelectedFileUnavailable) => {
            ctx.send(&error_terminal(404, "selected file not found"));
            Ok(false)
        }
        Err(AdmitError::History(_)) => {
            log("error", "chat_user_history_commit_failed");
            ctx.send(&error_terminal(503, "Admin chat history is unavailable"));
            Ok(false)
        }
        Err(AdmitError::Fault(_)) => Err(DispatchError::Authority),
    }
}

/// The message's route under the Space's chat gate.
fn spawn_route(ctx: &Ctx, turn: &Arc<Turn>, payload: Value, context: Context) -> TaskHandle {
    let (work_ctx, work_turn) = (ctx.clone(), Arc::clone(turn));
    TaskHandle::spawn(move |_| async move {
        let route_ctx = work_ctx.clone();
        let route_turn = Arc::clone(&work_turn);
        gated::run(&work_ctx, &work_turn, move || async move {
            let Some(job) = lifecycle::submit_route(&route_ctx, &payload, context) else {
                let refusal = error_terminal(429, "Assistant routing capacity reached");
                finish_active_turn(&route_ctx, &route_turn, &refusal).await;
                return Ok(());
            };
            {
                let mut state = route_turn.state();
                state.future = Some(Arc::new(job.clone()) as Arc<dyn Pending>);
                state.operation = "assistant-route";
            }
            route_delivery::deliver(&route_ctx, &route_turn, &payload, &job, None).await
        })
        .await;
    })
}

/// A sent chat message.
///
/// # Errors
///
/// Returns [`DispatchError::Authority`] when Team refused the admission's own request.
pub async fn dispatch_chat(ctx: &Ctx, frame: &Value) -> Result<(), DispatchError> {
    let Some((payload, identity)) = admit(ctx, frame).await? else {
        return Ok(());
    };
    if lifecycle::resolve(ctx, &payload).await {
        return Ok(());
    }
    let admitted = ctx.connection().admitted_history_id.clone();
    let store = Arc::clone(ctx.history());
    let conversation = match history::conversation(&store, ctx.team_id(), admitted.as_deref()).await
    {
        Ok(conversation) => conversation,
        Err(HistoryError::Invalid(_) | HistoryError::Unavailable) => {
            log("error", "chat_conversation_projection_failed");
            ctx.send(&error_terminal(503, "Admin chat history is unavailable"));
            return Ok(());
        }
    };
    let context = Context {
        reference: ctx.connection().assistant_reference.clone(),
        conversation: conversation.clone(),
    };
    let locale = json::get_str(&payload, "locale")
        .unwrap_or_default()
        .to_owned();
    let turn = route_delivery::begin(ctx, &locale, conversation, identity);
    turn.state().operation = "queued";
    let delivery = spawn_route(ctx, &turn, payload, context);
    turn.state().delivery = Some(delivery);
    Ok(())
}
