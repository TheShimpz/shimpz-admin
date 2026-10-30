//! The history's page for the session socket.

use super::{HistoryError, State, delivery::blocking};
use crate::{
    command::log,
    fault::{Fault, Outcome, Reply},
    team::{bridge, transport::Team},
};

/// One page of the chat's view of a Team's transcript, or with `routine` of that Routine's own history.
///
/// # Errors
///
/// Returns 400 for a request Admin refused before Team.
pub async fn page(
    history: &State,
    team: &Team,
    team_id: &str,
    before: Option<String>,
    routine: Option<String>,
) -> Outcome {
    match bridge::resolve_team_name(team, team_id)
        .await
        .map_err(Fault::bad_request)?
    {
        Ok(_) => {}
        Err(reply) => return Ok(reply),
    }
    let team_id = team_id.to_owned();
    match blocking(&history.store, move |store| {
        store.page(&team_id, before.as_deref(), routine.as_deref())
    })
    .await
    {
        Ok(page) => Ok(Reply::ok(page)),
        Err(HistoryError::Invalid(reason)) => Err(Fault::detail(400, reason)),
        Err(HistoryError::Unavailable) => {
            log("error", "chat_history_unavailable");
            Err(Fault::detail(503, "Admin chat history is unavailable"))
        }
    }
}
