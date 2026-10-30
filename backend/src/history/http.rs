//! The history's page for the session socket, and the transcript cleanup a Team's creation, deletion, or a Space reset
//! needs once Team committed it.

use super::{HistoryError, State, delivery::blocking};
use crate::{
    command::log,
    fault::{Fault, Outcome, Reply},
    json,
    team::{bridge, transport::Team},
};

fn cleaned(response: Reply, cleaned: Result<usize, HistoryError>) -> Reply {
    if cleaned.is_ok() {
        return response;
    }
    log("error", "chat_history_cleanup_unavailable");
    Reply::detail(
        503,
        "Team state changed, but Admin chat history cleanup did not complete",
    )
}

/// A Team Team created anew starts with an empty transcript.
pub async fn team_created(history: &State, team_id: &str, response: Reply) -> Reply {
    if !response.success() || response.get("created") != Some(&json::Value::Bool(true)) {
        return response;
    }
    let team_id = team_id.to_owned();
    let result = blocking(&history.store, move |store| store.clear_team(&team_id)).await;
    cleaned(response, result)
}

/// Deletes a Team with `action` while no history write may race it, then forgets its transcript; a Team already gone
/// is deleted as nothing.
///
/// # Errors
///
/// Returns the action's fault.
pub async fn team_delete<F>(history: &State, team_id: &str, action: F) -> Outcome
where
    F: Future<Output = Outcome>,
{
    let _lifecycle = history.lifecycle.lock().await;
    let mut response = action.await?;
    if response == Reply::detail(404, "Team not found") {
        response = Reply::ok(json::object(vec![("deleted", json::Value::Bool(false))]));
    }
    if !response.success() {
        return Ok(response);
    }
    let team_id = team_id.to_owned();
    let result = blocking(&history.store, move |store| store.clear_team(&team_id)).await;
    Ok(cleaned(response, result))
}

/// Resets the Space with `action` while no history write may race it, then forgets every transcript.
///
/// # Errors
///
/// Returns the action's fault.
pub async fn space_reset<F>(history: &State, action: F) -> Outcome
where
    F: Future<Output = Outcome>,
{
    let _lifecycle = history.lifecycle.lock().await;
    let response = action.await?;
    if !response.success() {
        return Ok(response);
    }
    let result = blocking(&history.store, super::store::Store::clear_all).await;
    Ok(cleaned(response, result))
}

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
