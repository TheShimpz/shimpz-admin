//! Persistence before projection for terminal chat events: every terminal ends its turn's receipt and is committed to
//! the Team's history before any page sees it, and a commit that fails still ends the turn visibly.

use std::sync::Arc;

use super::{history_terminal, progress::take_receipt};
use crate::{
    chat::{connection::Turn, projection::error_terminal, socket::Ctx},
    command::log,
    history::delivery,
    json::{self, Value},
};

/// Sends one turn's terminal once, committed first; whether it was sent.
pub async fn turn(ctx: &Ctx, turn: &Arc<Turn>, event: &Value, finish_history: bool) -> bool {
    let (history_id, unended, receipt) = {
        let mut connection = ctx.connection();
        let state = turn.state();
        if connection.closed || state.terminal_sent {
            return false;
        }
        let history_id = state.history_id.clone();
        let unended =
            state.operation == "pending-stop" && json::get_str(event, "type") == Some("error");
        drop(state);
        let receipt = take_receipt(&mut connection, history_id.as_deref());
        (history_id, unended, receipt)
    };
    let mut projected = event.clone();
    let committed = if unended {
        Ok(())
    } else {
        history_terminal(
            &ctx.app,
            ctx.team_id(),
            history_id.as_deref(),
            event,
            finish_history,
            receipt,
        )
        .await
    };
    {
        let mut connection = ctx.connection();
        if committed.is_err() {
            log("error", "chat_reply_history_commit_failed");
            projected = error_terminal(503, "Admin chat history is unavailable");
        } else {
            let ended = json::get_str(event, "type") == Some("done") || finish_history;
            if ended && history_id.is_some() && history_id == connection.pending_history_id {
                connection.pending_history_id = None;
            }
        }
        turn.state().terminal_sent = true;
    }
    ctx.send(&projected);
    true
}

/// Sends a resumed turn's terminal once, committed first when it ends the turn; whether it was sent.
pub async fn resumed(ctx: &Ctx, event: &Value, finish_history: bool) -> bool {
    let (history_id, receipt) = {
        let mut connection = ctx.connection();
        if connection.closed || connection.sync_terminal_sent {
            return false;
        }
        let history_id = connection.pending_history_id.clone();
        let receipt = take_receipt(&mut connection, history_id.as_deref());
        (history_id, receipt)
    };
    let mut projected = event.clone();
    if finish_history {
        let store = Arc::clone(ctx.history());
        match delivery::resumed_terminal(
            &store,
            ctx.team_id(),
            history_id.as_deref(),
            event,
            receipt,
        )
        .await
        {
            Err(_) => {
                log("error", "chat_resumed_reply_history_commit_failed");
                projected = error_terminal(503, "Admin chat history is unavailable");
            }
            Ok(()) => ctx.connection().pending_history_id = None,
        }
    }
    ctx.connection().sync_terminal_sent = true;
    ctx.send(&projected);
    true
}

/// Sends one event of a sync or continuation that has not ended yet.
pub fn sync_event(ctx: &Ctx, event: &Value) {
    let open = {
        let connection = ctx.connection();
        !connection.closed && !connection.sync_terminal_sent
    };
    if open {
        ctx.send(event);
    }
}
