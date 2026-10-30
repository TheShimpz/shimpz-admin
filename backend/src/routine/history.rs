//! What Routines need from Admin's chat history: writing a Routine notice or a card answer into its Team's transcript.
//! The chat domain owns the history store; this is the narrow interface Routines call (it shares the lifecycle lock in
//! [`crate::team::history`]).

use crate::{json::Value, process::app::App, team::history::HistoryUnavailable};

/// Writes one Routine notice version to its Team's transcript, idempotently per version; `false` when it conflicts
/// with its transcript row.
///
/// # Errors
///
/// Returns [`HistoryUnavailable`].
pub fn append_routine_notice(app: &App, notice: &Value) -> Result<bool, HistoryUnavailable> {
    app.domains
        .history
        .store
        .append_routine_notice(notice)
        .map_err(|_| HistoryUnavailable)
}

/// Keeps a Routine card's answer in its Team's transcript as soon as Team gives it, so a reload shows it answered.
///
/// # Errors
///
/// Returns [`HistoryUnavailable`].
pub fn append_proposal_answer(app: &App, answer: &Value) -> Result<bool, HistoryUnavailable> {
    app.domains
        .history
        .store
        .append_proposal_answer(answer)
        .map_err(|_| HistoryUnavailable)
}
