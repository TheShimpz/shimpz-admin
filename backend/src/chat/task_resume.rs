//! One-use task resumption after a reconnect: a capability continuation ("install it") resumes the original objective
//! through the same structured route, without admitting destructive lifecycle work.

use std::sync::Arc;

use super::{
    assistants::proposal::capability_continuation,
    connection::{Pending, TaskHandle, request_identity},
    delivery::{gated, route as route_delivery},
    lifecycle, payloads,
    projection::error_terminal,
    socket::{Ctx, DispatchError, stop::finish_active_turn},
};
use crate::{
    fault::Fault,
    history::{
        context::Entry,
        delivery::{self as history, AdmitError},
    },
    json::{self, Value},
};

const FIELDS: [&str; 8] = [
    "type",
    "message",
    "objective",
    "files",
    "assistant_ids",
    "objective_assistant_ids",
    "locale",
    "timezone",
];

fn chat_payload(frame: &Value, message: &str, files: &str, scope: &str) -> Result<Value, Fault> {
    let get = |key| frame.get(key).cloned().unwrap_or(Value::Null);
    let files = if files.is_empty() {
        Value::Array(Vec::new())
    } else {
        get(files)
    };
    payloads::chat_payload(&json::object(vec![
        ("message", get(message)),
        ("files", files),
        ("assistant_ids", get(scope)),
        ("locale", get("locale")),
        ("timezone", get("timezone")),
        ("refine", Value::Null),
    ]))
}

fn canonical(frame: &Value) -> Option<(Value, Value)> {
    if !json::has_exactly(frame, &FIELDS) {
        return None;
    }
    let payload = chat_payload(frame, "message", "files", "assistant_ids").ok()?;
    let objective = chat_payload(frame, "objective", "", "objective_assistant_ids").ok()?;
    let message = |value: &Value| {
        json::get_str(value, "message")
            .unwrap_or_default()
            .to_owned()
    };
    let no_files = payload
        .get("files")
        .and_then(json::as_array)
        .is_some_and(<[Value]>::is_empty);
    let valid = no_files
        && payload.get("assistant_ids") == objective.get("assistant_ids")
        && capability_continuation(&message(&payload))
        && !capability_continuation(&message(&objective));
    valid.then_some((payload, objective))
}

/// The resumed turn's admitted user row and its conversation window, or `None` after an error terminal. A resumed task
/// never carries files, so its turn is never attached; its window still holds the original objective.
async fn admitted(
    ctx: &Ctx,
    payload: &Value,
) -> Result<Option<(String, Vec<Entry>)>, DispatchError> {
    let message = payload.get("message").cloned().unwrap_or(Value::Null);
    let history_id = match history::admit(&ctx.app, &ctx.team, ctx.team_id(), &message, &[]).await {
        Ok(history_id) => history_id,
        Err(AdmitError::Saturated) => {
            ctx.send(&error_terminal(429, "Admin chat history capacity reached"));
            return Ok(None);
        }
        Err(AdmitError::Fault(_)) => return Err(DispatchError::Authority),
        Err(_) => {
            ctx.send(&error_terminal(503, "Admin chat history is unavailable"));
            return Ok(None);
        }
    };
    let store = Arc::clone(ctx.history());
    let Ok(conversation) = history::conversation(&store, ctx.team_id(), Some(&history_id)).await
    else {
        ctx.send(&error_terminal(503, "Admin chat history is unavailable"));
        return Ok(None);
    };
    Ok(Some((history_id, conversation)))
}

/// The resumed objective's route under the Space's chat gate, falling back to the continuation's own turn.
fn spawn_route(
    ctx: &Ctx,
    turn: &Arc<crate::chat::connection::Turn>,
    objective: Value,
    payload: Value,
) -> TaskHandle {
    let (work_ctx, work_turn) = (ctx.clone(), Arc::clone(turn));
    TaskHandle::spawn(move |_| async move {
        let route_ctx = work_ctx.clone();
        let route_turn = Arc::clone(&work_turn);
        gated::run(&work_ctx, &work_turn, move || async move {
            let Some(job) = lifecycle::submit_resume(&route_ctx, &objective) else {
                let refusal = error_terminal(429, "Assistant routing capacity reached");
                finish_active_turn(&route_ctx, &route_turn, &refusal).await;
                return Ok(());
            };
            {
                let mut state = route_turn.state();
                state.future = Some(Arc::new(job.clone()) as Arc<dyn Pending>);
                state.operation = "assistant-route";
            }
            route_delivery::deliver(&route_ctx, &route_turn, &objective, &job, Some(&payload)).await
        })
        .await;
    })
}

/// A reconnected page's task resumption.
///
/// # Errors
///
/// Returns [`DispatchError::Authority`] when Team refused the admission's own request.
pub async fn dispatch(ctx: &Ctx, frame: &Value) -> Result<(), DispatchError> {
    let Some((payload, objective)) = canonical(frame) else {
        ctx.send(&error_terminal(400, "invalid task resume request"));
        return Ok(());
    };
    {
        let connection = ctx.connection();
        if connection.active.is_some()
            || connection.sync_task.is_some()
            || connection.lifecycle.is_some()
        {
            drop(connection);
            ctx.send(&error_terminal(409, "a chat turn is already active"));
            return Ok(());
        }
        if connection.pending_challenge_id.is_some() {
            drop(connection);
            ctx.send(&error_terminal(
                409,
                "an Assistant challenge must be resolved before another turn",
            ));
            return Ok(());
        }
    }
    let identity = request_identity(ctx.app.clock.now_secs());
    let Some((history_id, conversation)) = admitted(ctx, &payload).await? else {
        return Ok(());
    };
    ctx.connection().admitted_history_id = Some(history_id);
    let locale = json::get_str(&objective, "locale")
        .unwrap_or_default()
        .to_owned();
    let turn = route_delivery::begin(ctx, &locale, conversation, identity);
    turn.state().operation = "queued";
    let delivery = spawn_route(ctx, &turn, objective, payload);
    turn.state().delivery = Some(delivery);
    Ok(())
}
