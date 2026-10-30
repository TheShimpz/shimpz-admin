//! Commits and projects one Team-owned chat challenge: its turn becomes the Team's resumable turn first.

use std::sync::Arc;

use super::terminal;
use crate::{
    chat::{connection::Turn, projection::error_terminal, socket::Ctx},
    history::delivery,
    json::Value,
    process::command::log,
};

/// Binds the paused turn to its challenge, then shows the challenge.
pub async fn deliver(ctx: &Ctx, turn: &Arc<Turn>, challenge: &Value, kind: &'static str) {
    let history_id = turn.state().history_id.clone();
    let store = Arc::clone(ctx.history());
    if delivery::challenge(&store, ctx.team_id(), history_id.as_deref())
        .await
        .is_err()
    {
        log("error", "chat_challenge_history_commit_failed");
        terminal::turn(
            ctx,
            turn,
            &error_terminal(503, "Admin chat history is unavailable"),
            false,
        )
        .await;
        return;
    }
    {
        let mut connection = ctx.connection();
        connection.pending_history_id = history_id;
        connection.remember_challenge(challenge, kind);
    }
    ctx.send(challenge);
}
