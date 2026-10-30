//! How a run's work reaches its pages and its Team's history: progress before results, every terminal committed before
//! it is shown, challenges bound to their turn, and the Assistant lifecycle cards.

pub mod challenge;
pub mod gated;
pub mod plan;
pub mod progress;
pub mod route;
pub mod sync;
pub mod terminal;
pub mod uninstall;

use crate::{
    history::{HistoryError, delivery},
    json::Value,
    process::app::App,
};

/// Keeps how one turn ended in its Team's history.
///
/// # Errors
///
/// Returns [`HistoryError`] when it was not committed.
pub async fn history_terminal(
    app: &App,
    team_id: &str,
    turn: Option<&str>,
    event: &Value,
    finish: bool,
    receipt: Option<Value>,
) -> Result<(), HistoryError> {
    delivery::terminal(
        &app.domains.history.store,
        team_id,
        turn,
        event,
        finish,
        receipt,
    )
    .await
}
