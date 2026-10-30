//! Deterministic delivery of one admitted Assistant uninstall discovery turn: its proposal card.

use std::sync::Arc;

use super::terminal;
use crate::chat::{
    assistants::proposal::UninstallTarget, connection::Turn, lifecycle, projection::error_terminal,
    socket::Ctx,
};

/// Delivers one already-resolved uninstall target as its proposal.
pub async fn deliver_candidate(ctx: &Ctx, turn: &Arc<Turn>, target: &UninstallTarget) {
    let (locale, history_id) = {
        let state = turn.state();
        (state.locale.clone(), state.history_id.clone())
    };
    let event = match lifecycle::create_proposal(ctx, target, locale.as_deref()) {
        Some((proposal, event)) => {
            let mut connection = ctx.connection();
            connection.lifecycle_proposal = Some(proposal);
            lifecycle::retain_history(&mut connection, history_id, &event);
            event
        }
        None => error_terminal(503, "Assistant inventory is unavailable"),
    };
    terminal::turn(ctx, turn, &event, false).await;
}
