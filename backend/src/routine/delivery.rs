//! Delivers Team's Routine notices to each Team's transcript (ADR-0086).
//!
//! A notice is written before its exact version is acknowledged, so a crash between them only delivers it again, and
//! the transcript write is idempotent per version. Every notice tells each Team's Routine list to refresh.

use super::{history, team};
use crate::{
    json::{self, Value},
    process::app::App,
    team::history as team_history,
};

/// The most batches one delivery reads.
pub const MAX_BATCHES: usize = 32;

/// Why a delivery stopped; the next tick delivers again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryError {
    /// Team did not answer in its closed form.
    Team,
    /// The chat history could not take a notice.
    History,
}

impl From<team::RoutineTeamError> for DeliveryError {
    fn from(_: team::RoutineTeamError) -> Self {
        Self::Team
    }
}

impl From<team_history::HistoryUnavailable> for DeliveryError {
    fn from(_: team_history::HistoryUnavailable) -> Self {
        Self::History
    }
}

/// One batch read, written, and acknowledged while no Team deletion or Space reset runs; its notices.
async fn batch(app: &App) -> Result<(Vec<Value>, bool), DeliveryError> {
    let machine = app.machine_team();
    let _lifecycle = team_history::lifecycle(app).await;
    let batch = team::notices(&machine).await?;
    let notices = batch
        .get("notices")
        .and_then(json::as_array)
        .unwrap_or_default()
        .to_vec();
    for notice in &notices {
        if !history::append_routine_notice(app, notice)? {
            return Err(DeliveryError::History);
        }
    }
    if !notices.is_empty() {
        team::acknowledge(&machine, &notices).await?;
    }
    Ok((notices, batch.get("more") == Some(&Value::Bool(true))))
}

/// Delivers and acknowledges every undelivered notice, one bounded batch at a time; how many it delivered.
///
/// # Errors
///
/// Returns [`DeliveryError`].
pub async fn deliver(app: &App) -> Result<usize, DeliveryError> {
    let mut written = 0;
    for _ in 0..MAX_BATCHES {
        let (notices, more) = batch(app).await?;
        let mut teams: Vec<&str> = notices
            .iter()
            .filter_map(|notice| json::get_str(notice, "team_id"))
            .collect();
        teams.sort_unstable();
        teams.dedup();
        for team_id in teams {
            app.topics.team_changed(team_id, &["routines"]);
        }
        written += notices.len();
        if !more {
            return Ok(written);
        }
    }
    Ok(written)
}
