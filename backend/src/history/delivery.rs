//! The commit boundary for chat presentation events: each store call runs off the async workers, and a user message
//! is admitted on its own one-worker lane, serialized with Team deletion and Space reset.

use std::sync::Arc;

use super::{HistoryError, context::Entry, store::Store};
use crate::{
    fault::Fault,
    json::{self, Value},
    lanes::Ended,
    process::app::App,
    team::{bridge, transport::Team},
};

/// Why a user message was not admitted.
#[derive(Clone, Debug, PartialEq)]
pub enum AdmitError {
    /// The admission lane is full.
    Saturated,
    /// A file the message selected is no longer one of the Team's files.
    SelectedFileUnavailable,
    /// The history refused or could not commit it.
    History(HistoryError),
    /// Team refused the request before answering it.
    Fault(Fault),
}

impl From<HistoryError> for AdmitError {
    fn from(error: HistoryError) -> Self {
        Self::History(error)
    }
}

/// Runs one store call off the async workers.
///
/// # Errors
///
/// Returns the call's error, or [`HistoryError::Unavailable`] when it could not run.
pub async fn blocking<T, F>(store: &Arc<Store>, call: F) -> Result<T, HistoryError>
where
    F: FnOnce(&Store) -> Result<T, HistoryError> + Send + 'static,
    T: Send + 'static,
{
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || call(&store))
        .await
        .unwrap_or(Err(HistoryError::Unavailable))
}

/// The Team's own metadata of each selected file, in the message's order; never the browser's word for it.
async fn file_references(
    team: &Team,
    team_id: &str,
    file_ids: &[String],
) -> Result<Vec<Value>, AdmitError> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let response = bridge::list_files(team, team_id)
        .await
        .map_err(AdmitError::Fault)?;
    if !response.success() {
        return Err(HistoryError::Unavailable.into());
    }
    let stored = response
        .get("files")
        .and_then(json::as_array)
        .unwrap_or_default();
    file_ids
        .iter()
        .map(|file_id| {
            let item = stored
                .iter()
                .find(|item| json::get_str(item, "id") == Some(file_id.as_str()))
                .ok_or(AdmitError::SelectedFileUnavailable)?;
            let keys = super::store::FILE_REFERENCE_KEYS;
            let members = keys
                .iter()
                .map(|key| {
                    item.get(key)
                        .cloned()
                        .map(|value| (*key, value))
                        .ok_or(AdmitError::SelectedFileUnavailable)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json::object(members))
        })
        .collect()
}

async fn append_live_user(
    app: Arc<App>,
    team: Team,
    team_id: String,
    turn: String,
    message: Value,
    files: Vec<String>,
) -> Result<bool, AdmitError> {
    let _lifecycle = crate::team::history::lifecycle(&app).await;
    match bridge::resolve_team_name(&team, &team_id).await {
        Ok(Ok(_)) => {}
        Ok(Err(_)) => return Err(HistoryError::Unavailable.into()),
        Err(fault) => return Err(AdmitError::Fault(fault)),
    }
    let references = file_references(&team, &team_id, &files).await?;
    let store = Arc::clone(&app.domains.history.store);
    Ok(blocking(&store, move |store| {
        store.append_user(&team_id, &turn, &message, &references)
    })
    .await?)
}

/// Admits one user message with references to the files it selected (ADR-0093); its turn id.
///
/// # Errors
///
/// Returns [`AdmitError`].
pub async fn admit(
    app: &Arc<App>,
    team: &Team,
    team_id: &str,
    message: &Value,
    files: &[String],
) -> Result<String, AdmitError> {
    let turn = crate::random::hex(16);
    let job = app
        .domains
        .history
        .admission
        .submit(append_live_user(
            Arc::clone(app),
            team.clone(),
            team_id.to_owned(),
            turn.clone(),
            message.clone(),
            files.to_vec(),
        ))
        .map_err(|_| AdmitError::Saturated)?;
    match job.wait().await {
        Ended::Done(Ok(true)) => Ok(turn),
        Ended::Done(Ok(false)) | Ended::Cancelled | Ended::Panicked => {
            Err(HistoryError::Unavailable.into())
        }
        Ended::Done(Err(error)) => Err(error),
    }
}

/// The conversation window before `turn`.
///
/// # Errors
///
/// Returns [`HistoryError`]; a turn that was never admitted has no window.
pub async fn conversation(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
) -> Result<Vec<Entry>, HistoryError> {
    let turn = turn.ok_or(HistoryError::Unavailable)?.to_owned();
    let team_id = team_id.to_owned();
    blocking(store, move |store| store.conversation(&team_id, &turn)).await
}

fn committed(written: bool) -> Result<(), HistoryError> {
    if written {
        Ok(())
    } else {
        Err(HistoryError::Unavailable)
    }
}

/// Keeps how one turn ended: its reply, or its stopped or failed status; `finish` also ends its resumable state.
///
/// # Errors
///
/// Returns [`HistoryError`] when the ending was not committed.
pub async fn terminal(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
    event: &Value,
    finish: bool,
    receipt: Option<Value>,
) -> Result<(), HistoryError> {
    let Some(turn) = turn.map(str::to_owned) else {
        return Ok(());
    };
    let (team_id, event) = (team_id.to_owned(), event.clone());
    match json::get_str(&event, "type") {
        Some("done") => {
            let written = blocking(store, move |store| {
                store.append_reply(&team_id, &turn, &event, receipt.as_ref())
            })
            .await?;
            committed(written)
        }
        Some("error" | "stopped") => {
            let written = blocking(store, move |store| {
                store.append_status(&team_id, &turn, &event, finish)
            })
            .await?;
            committed(written)
        }
        _ if finish => blocking(store, move |store| store.finish_resumable_turn(&turn)).await,
        _ => Ok(()),
    }
}

/// Binds the Team's resumable turn to a turn Team paused for a challenge.
///
/// # Errors
///
/// Returns [`HistoryError`] when it was not bound.
pub async fn challenge(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
) -> Result<(), HistoryError> {
    let Some(turn) = turn.map(str::to_owned) else {
        return Ok(());
    };
    let team_id = team_id.to_owned();
    committed(
        blocking(store, move |store| {
            store.bind_resumable_turn(&team_id, &turn)
        })
        .await?,
    )
}

/// The Team's resumable turn, which must exist.
///
/// # Errors
///
/// Returns [`HistoryError`] when there is none.
pub async fn resume(store: &Arc<Store>, team_id: &str) -> Result<String, HistoryError> {
    observe(store, team_id)
        .await?
        .ok_or(HistoryError::Unavailable)
}

/// The Team's resumable turn, if any.
///
/// # Errors
///
/// Returns [`HistoryError`].
pub async fn observe(store: &Arc<Store>, team_id: &str) -> Result<Option<String>, HistoryError> {
    let team_id = team_id.to_owned();
    blocking(store, move |store| store.resumable_turn(&team_id)).await
}

/// `turn`, when it is still the Team's resumable turn.
///
/// # Errors
///
/// Returns [`HistoryError`] when it is not.
pub async fn resume_exact(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
) -> Result<String, HistoryError> {
    let turn = turn.ok_or(HistoryError::Unavailable)?;
    if observe(store, team_id).await?.as_deref() == Some(turn) {
        Ok(turn.to_owned())
    } else {
        Err(HistoryError::Unavailable)
    }
}

/// Ends a resumable turn nothing resumes.
///
/// # Errors
///
/// Returns [`HistoryError`].
pub async fn abandon(store: &Arc<Store>, turn: Option<&str>) -> Result<(), HistoryError> {
    let Some(turn) = turn.map(str::to_owned) else {
        return Ok(());
    };
    blocking(store, move |store| store.finish_resumable_turn(&turn)).await
}

/// Keeps how a resumed turn ended; the turn it resumed must still be known.
///
/// # Errors
///
/// Returns [`HistoryError`].
pub async fn resumed_terminal(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
    event: &Value,
    receipt: Option<Value>,
) -> Result<(), HistoryError> {
    let turn = turn.ok_or(HistoryError::Unavailable)?;
    terminal(store, team_id, Some(turn), event, true, receipt).await
}

/// Keeps one turn's lifecycle guidance.
///
/// # Errors
///
/// Returns [`HistoryError`].
pub async fn guidance(
    store: &Arc<Store>,
    team_id: &str,
    turn: Option<&str>,
    code: &str,
    reply: &str,
) -> Result<(), HistoryError> {
    let Some(turn) = turn.map(str::to_owned) else {
        return Ok(());
    };
    let (team_id, code, reply) = (team_id.to_owned(), code.to_owned(), reply.to_owned());
    committed(
        blocking(store, move |store| {
            store.append_guidance(&team_id, &turn, &code, &reply)
        })
        .await?,
    )
}
