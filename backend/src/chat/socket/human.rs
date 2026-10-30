//! A page's answer to a pending human request: authenticated by the Action password authority chat and frozen Routine
//! runs share, then continued in Team under the Space's chat gate.

use std::sync::Arc;

use super::{Ctx, DispatchError, sync::gated_continuation};
use crate::{
    chat::{
        connection::TaskHandle,
        delivery::terminal::{resumed, sync_event},
        human,
        local::{
            Answer,
            turn::{self as local_turn, Progress, Submission},
        },
        projection::{error_terminal, failed, first_challenge, turn_terminal},
    },
    json::{self, Value},
};

fn authenticated_denial(answer: &Answer) -> bool {
    answer.public
        && answer.reply.status == 409
        && json::equal(&answer.reply.body, &json::code("human-request-denied"))
}

async fn deliver(
    ctx: Ctx,
    payload: Value,
    assurance: Option<Value>,
    failure: Option<(u16, &'static str)>,
    id: u64,
) {
    let submit = |report: Progress| {
        let submission = Submission::Human {
            payload: payload.clone(),
            assurance: assurance.clone(),
        };
        let (app, team, team_id) = (
            Arc::clone(&ctx.app),
            ctx.team.clone(),
            ctx.team_id().to_owned(),
        );
        ctx.app
            .domains
            .chat
            .lanes
            .sync
            .submit(
                async move { local_turn::submit(&app, &team, &team_id, submission, &report).await },
            )
            .ok()
    };
    let response = gated_continuation(&ctx, &submit).await;
    match response {
        Some(answer) if !ctx.closed() => conclude(&ctx, &answer, failure).await,
        _ => {
            if !ctx.closed() {
                resumed(&ctx, &failed(502), false).await;
            }
        }
    }
    let mut connection = ctx.connection();
    if connection
        .sync_task
        .as_ref()
        .is_some_and(|task| task.id == id)
    {
        connection.sync_task = None;
    }
}

async fn conclude(ctx: &Ctx, answer: &Answer, failure: Option<(u16, &'static str)>) {
    let team_id = ctx.team_id().to_owned();
    if let Some((status, detail)) = failure {
        let mut confirmed = authenticated_denial(answer);
        let event = if confirmed {
            error_terminal(status, detail)
        } else {
            turn_terminal(answer, &team_id)
        };
        confirmed = confirmed || json::get_str(&event, "type") == Some("done");
        if confirmed {
            ctx.connection().forget_challenge();
        }
        resumed(ctx, &event, confirmed).await;
        return;
    }
    if let Some((challenge, kind)) = first_challenge(answer, &team_id) {
        ctx.connection().remember_challenge(&challenge, kind);
        sync_event(ctx, &challenge);
        return;
    }
    let event = turn_terminal(answer, &team_id);
    let confirmed = json::get_str(&event, "type") == Some("done");
    if confirmed {
        ctx.connection().forget_challenge();
    }
    resumed(ctx, &event, confirmed).await;
}

/// A page's human response frame.
///
/// # Errors
///
/// Never; the signature matches the other frames'.
pub async fn dispatch_human_response(ctx: &Ctx, frame: &Value) -> Result<(), DispatchError> {
    let request = {
        let connection = ctx.connection();
        if connection.active.is_some() || connection.sync_task.is_some() {
            drop(connection);
            ctx.send(&error_terminal(409, "a chat operation is already active"));
            return Ok(());
        }
        let pending = connection.pending_challenge_type == Some("human")
            && connection.pending_challenge_id.as_deref() == json::get_str(frame, "challenge_id");
        let Some(request) = connection.pending_human_request.clone().filter(|_| pending) else {
            drop(connection);
            ctx.send(&error_terminal(409, "the human challenge is not pending"));
            return Ok(());
        };
        request
    };
    let answered = match human::response_payload(frame, &request, &ctx.app.action_passwords).await {
        Ok(answered) => answered,
        Err(error) => {
            ctx.send(&error_terminal(error.status, error.detail));
            return Ok(());
        }
    };
    if let Some(rejection) = answered.rejection {
        ctx.send(&rejection);
        return Ok(());
    }
    let Some(payload) = answered.payload else {
        ctx.send(&error_terminal(503, "authentication is unavailable"));
        return Ok(());
    };
    let mut connection = ctx.connection();
    connection.sync_terminal_sent = false;
    let (task_ctx, assurance, failure) = (ctx.clone(), answered.assurance, answered.failure);
    connection.sync_task = Some(TaskHandle::spawn(move |id| {
        deliver(task_ctx, payload, assurance, failure, id)
    }));
    Ok(())
}
