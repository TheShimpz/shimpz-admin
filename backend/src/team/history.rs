//! What Team lifecycle needs from Admin's chat domain: the chat history's lifecycle lock and cleanup, and the end of a
//! Team's chat runs (ADR-0119). The chat domain owns these; this is the narrow interface Team lifecycle calls.

use tokio::sync::MutexGuard;

use crate::{fault::Reply, json, process::app::App};

/// The chat history cannot be read or written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryUnavailable;

/// Holds the history's lifecycle lock: no Team deletion, Space reset, or notice delivery runs meanwhile.
pub async fn lifecycle(app: &App) -> MutexGuard<'_, ()> {
    app.domains.team.lifecycle.lock().await
}

/// Removes one Team's transcript.
///
/// # Errors
///
/// Returns [`HistoryUnavailable`].
pub fn clear_team(app: &App, team_id: &str) -> Result<(), HistoryUnavailable> {
    app.domains
        .history
        .store
        .clear_team(team_id)
        .map(|_| ())
        .map_err(|_| HistoryUnavailable)
}

/// Removes every transcript.
///
/// # Errors
///
/// Returns [`HistoryUnavailable`].
pub fn clear_all(app: &App) -> Result<(), HistoryUnavailable> {
    app.domains
        .history
        .store
        .clear_all()
        .map(|_| ())
        .map_err(|_| HistoryUnavailable)
}

/// Ends the chat run of one Team, or of every Team: whoever watched it, its work stops with the Team.
pub fn end_runs(app: &App, team_id: Option<&str>) {
    crate::chat::run::end_runs(app, team_id);
}

/// A successful Team change whose history cleanup failed is answered 503; anything else as it was.
#[must_use]
pub fn cleanup(response: Reply, action: impl FnOnce() -> Result<(), HistoryUnavailable>) -> Reply {
    if !response.success() {
        return response;
    }
    if action().is_err() {
        crate::process::command::log("error", "chat_history_cleanup_unavailable");
        return Reply::new(
            503,
            json::detail("Team state changed, but Admin chat history cleanup did not complete"),
        );
    }
    response
}
