//! Restores one durable Team chat continuation onto a run: the pending challenge a page answers again, an empty sync,
//! or the terminal of an Integration continuation that ran meanwhile.

use std::sync::Arc;

use super::terminal::{resumed, sync_event};
use crate::{
    chat::{
        local::Answer,
        projection::{
            error_terminal, first_challenge, human_challenge_event, integration_challenge_event,
            turn_terminal,
        },
        socket::Ctx,
    },
    history::delivery,
    json::{self, Value},
};

/// Whether Team said nothing is pending.
#[must_use]
pub fn is_empty_pending(answer: &Answer, team_id: &str) -> bool {
    answer.reply.success()
        && json::equal(
            &answer.reply.body,
            &json::object(vec![
                ("team_id", json::text(team_id)),
                ("status", json::text("none")),
            ]),
        )
}

fn pending_error(answer: &Answer, team_id: &str, kind: &str) -> Value {
    if answer.reply.success() {
        return error_terminal(502, &format!("the Assistant {kind} challenge was invalid"));
    }
    turn_terminal(answer, team_id)
}

async fn restore_history(ctx: &Ctx) -> bool {
    let pending = ctx.connection().pending_history_id.clone();
    let store = Arc::clone(ctx.history());
    let Ok(history_id) = delivery::resume_exact(&store, ctx.team_id(), pending.as_deref()).await
    else {
        resumed(
            ctx,
            &error_terminal(503, "Admin chat history is unavailable"),
            false,
        )
        .await;
        return false;
    };
    ctx.connection().pending_history_id = Some(history_id);
    true
}

async fn empty(ctx: &Ctx) {
    let pending = ctx.connection().pending_history_id.clone();
    let store = Arc::clone(ctx.history());
    if delivery::abandon(&store, pending.as_deref()).await.is_err() {
        resumed(
            ctx,
            &error_terminal(503, "Admin chat history is unavailable"),
            false,
        )
        .await;
        return;
    }
    {
        let mut connection = ctx.connection();
        connection.pending_history_id = None;
        connection.forget_challenge();
    }
    sync_event(ctx, &json::object(vec![("type", json::text("sync-empty"))]));
}

async fn integration_terminal(ctx: &Ctx, pending: &Value, answer: &Answer) {
    let challenged = answer.reply.status == 428
        || matches!(
            answer.reply.get_str("status"),
            Some("human-required" | "integrations-required")
        );
    if challenged {
        ctx.connection().forget_challenge();
        resumed(
            ctx,
            &error_terminal(502, "the Assistant integration challenge was invalid"),
            false,
        )
        .await;
        return;
    }
    if !restore_history(ctx).await {
        return;
    }
    let event = turn_terminal(answer, ctx.team_id());
    if json::get_str(&event, "type") == Some("done") {
        ctx.connection().forget_challenge();
        resumed(ctx, &event, true).await;
        return;
    }
    ctx.connection().remember_challenge(pending, "integration");
    resumed(ctx, &event, false).await;
}

/// Delivers one explicit Integration synchronization result.
pub async fn integration(ctx: &Ctx, pending: &Answer, continued: Option<&Answer>) {
    let team_id = ctx.team_id().to_owned();
    let Some(challenge) = integration_challenge_event(pending, &team_id) else {
        if is_empty_pending(pending, &team_id) {
            empty(ctx).await;
        } else {
            resumed(ctx, &pending_error(pending, &team_id, "integration"), false).await;
        }
        return;
    };
    let Some(continued) = continued else {
        resumed(
            ctx,
            &error_terminal(502, "the Assistant integration challenge was invalid"),
            false,
        )
        .await;
        return;
    };
    if let Some((next, kind)) = first_challenge(continued, &team_id) {
        if pending.reply.get("turn_id") != continued.reply.get("turn_id") {
            resumed(
                ctx,
                &error_terminal(502, "the Assistant integration challenge was invalid"),
                false,
            )
            .await;
            return;
        }
        if !restore_history(ctx).await {
            return;
        }
        ctx.connection().remember_challenge(&next, kind);
        sync_event(ctx, &next);
        return;
    }
    integration_terminal(ctx, &challenge, continued).await;
}

/// Delivers one human synchronization result.
pub async fn human(ctx: &Ctx, pending: &Answer) {
    let team_id = ctx.team_id().to_owned();
    if let Some(challenge) = human_challenge_event(pending, &team_id) {
        if !restore_history(ctx).await {
            return;
        }
        ctx.connection().remember_challenge(&challenge, "human");
        sync_event(ctx, &challenge);
        return;
    }
    if is_empty_pending(pending, &team_id) {
        empty(ctx).await;
        return;
    }
    resumed(ctx, &pending_error(pending, &team_id, "human"), false).await;
}
