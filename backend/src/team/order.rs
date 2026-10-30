//! Local Team list order: the Supervisor's saved arrangement over Team's newest-first inventory.
//!
//! `team-order.json` is Admin-owned presentation state beside, never inside, `admin.json`: exactly `{"team_ids"}` with
//! at most 128 unique canonical Team ids in a private regular file. A Team the saved order does not name leads, newest
//! first as Team lists it; the saved ids that still name a Team follow in saved order. A read never rewrites the file.
//! A missing file is the newest-first order, and a file that cannot be read or validated falls back to it with a
//! sanitized diagnostic; a failed Supervisor, inventory, or ownership check is never bypassed.
//!
//! One lock (`team::State::order`) serializes a reorder with Admin's Team creation, deletion, and Space reset, so a
//! saved position never outlives its Team into a later Team that reuses the id.

use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use super::{
    bridge::{self, TeamEntry},
    transport::Team,
};
use crate::{
    app::App,
    command::log,
    fault::{Fault, Outcome, Reply},
    fsio::{self, PrivateReadError, Requirements},
    http::body,
    json::{self, Value},
};

/// The largest saved order.
pub const MAX_ORDER_BYTES: u64 = 8 * 1024;

/// Why the saved order cannot be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderError {
    /// It cannot be read or committed safely.
    Unavailable,
    /// It exists but is not a valid private order, so it names no Team.
    Invalid,
}

/// At most 128 unique canonical Team ids, exactly as sent.
#[must_use]
pub fn canonical_ids(value: &Value) -> Option<Vec<String>> {
    let items = json::as_array(value).filter(|items| items.len() <= bridge::MAX_TEAMS)?;
    let mut ids: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let text = json::as_str(item)?;
        if team_protocol::identifiers::canonical_team_id(item) != Some(text)
            || ids.iter().any(|known| known == text)
        {
            return None;
        }
        ids.push(text.to_owned());
    }
    Some(ids)
}

/// The saved order at `path`, or `None` when none is saved.
///
/// # Errors
///
/// Returns [`OrderError`].
pub fn load(path: &Path) -> Result<Option<Vec<String>>, OrderError> {
    let requirements = Requirements {
        group: None,
        single_link: true,
    };
    let raw = match fsio::read_private(path, MAX_ORDER_BYTES, requirements) {
        Ok(raw) => raw,
        Err(PrivateReadError::NotFound) => return Ok(None),
        Err(PrivateReadError::Io) => return Err(OrderError::Unavailable),
        Err(PrivateReadError::Unsafe) => return Err(OrderError::Invalid),
    };
    let value = json::parse(&raw).map_err(|_| OrderError::Invalid)?;
    if !json::has_exactly(&value, &["team_ids"]) {
        return Err(OrderError::Invalid);
    }
    canonical_ids(value.get("team_ids").unwrap_or(&Value::Null))
        .map(Some)
        .ok_or(OrderError::Invalid)
}

fn sync_parent(path: &Path) -> Result<(), OrderError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    match fsio::sync_directory(parent) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(OrderError::Unavailable),
    }
}

fn save(path: &Path, team_ids: &[String]) -> Result<(), OrderError> {
    let payload = json::compact(&json::object(vec![("team_ids", json::strings(team_ids))]));
    fsio::replace_atomically(path, payload.as_bytes()).map_err(|_| OrderError::Unavailable)
}

/// Removes one cleanup entry only when it is this Admin's own regular file; anything else stays and refuses.
fn unlink_owned(path: &Path) -> Result<(), OrderError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(OrderError::Unavailable),
    };
    if !metadata.file_type().is_file() || metadata.uid() != fsio::euid() {
        return Err(OrderError::Unavailable);
    }
    std::fs::remove_file(path).map_err(|_| OrderError::Unavailable)
}

/// The saved order a lifecycle mutation edits; an invalid one is removed, never read as naming no Team.
fn saved_for_mutation(path: &Path) -> Result<Option<Vec<String>>, OrderError> {
    match load(path) {
        Err(OrderError::Invalid) => {
            log("warning", "team_order_invalid_removed");
            unlink_owned(path)?;
            Ok(None)
        }
        other => other,
    }
}

/// Durably removes one Team's saved position.
///
/// # Errors
///
/// Returns [`OrderError::Unavailable`].
pub fn forget(path: &Path, team_id: &str) -> Result<(), OrderError> {
    match saved_for_mutation(path)? {
        Some(saved) if saved.iter().any(|item| item == team_id) => {
            let kept: Vec<String> = saved.into_iter().filter(|item| item != team_id).collect();
            save(path, &kept)
        }
        _ => sync_parent(path),
    }
}

fn temporaries(path: &Path) -> Vec<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let prefix = format!(".{name}.");
    std::fs::read_dir(parent)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|candidate| {
                    candidate
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with(&prefix)
                                && std::path::Path::new(name)
                                    .extension()
                                    .is_some_and(|extension| extension == "tmp")
                        })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Durably removes the saved order and any temporary file an interrupted write left; only Admin's own regular files.
///
/// # Errors
///
/// Returns [`OrderError::Unavailable`] when an entry that is not Admin's own file stays, after the rest is durable.
pub fn clear(path: &Path) -> Result<(), OrderError> {
    let mut unsafe_entry = false;
    for entry in std::iter::once(path.to_path_buf()).chain(temporaries(path)) {
        unsafe_entry |= unlink_owned(&entry).is_err();
    }
    sync_parent(path)?;
    if unsafe_entry {
        Err(OrderError::Unavailable)
    } else {
        Ok(())
    }
}

/// Unsaved Teams first in Team's newest-first order, then the surviving saved ids in saved order.
#[must_use]
pub fn arrange(teams: &[TeamEntry], saved: Option<&[String]>) -> Vec<TeamEntry> {
    let saved = saved.unwrap_or_default();
    teams
        .iter()
        .filter(|team| !saved.contains(&team.team_id))
        .cloned()
        .chain(
            saved
                .iter()
                .filter_map(|id| teams.iter().find(|team| &team.team_id == id).cloned()),
        )
        .collect()
}

fn unavailable(detail: &str) -> Reply {
    Reply::new(503, json::detail_code(detail, "team-order-unavailable"))
}

/// Team's authoritative inventory, read now; an unavailable or invalid one is never replaced by a guess.
async fn fresh_inventory(team: &Team) -> Result<Vec<TeamEntry>, Reply> {
    bridge::team_inventory(&bridge::list_teams(team).await).map_err(|failure| {
        if failure.status >= 500 {
            Reply::new(
                503,
                json::detail_code(
                    "The Team list is unavailable; try again",
                    "team-inventory-unavailable",
                ),
            )
        } else {
            failure
        }
    })
}

/// The Local Team list in the Supervisor's order (the saved order at `path`).
pub async fn listing_at(team: &Team, path: &Path) -> Reply {
    let response = bridge::list_teams(team).await;
    let teams = match bridge::team_inventory(&response) {
        Ok(teams) => teams,
        Err(failure) => return failure,
    };
    let saved = load(path).unwrap_or_else(|_| {
        log("warning", "team_order_unavailable_listing_newest_first");
        None
    });
    let mut body = response.body.clone();
    json::set(
        &mut body,
        "teams",
        bridge::inventory_value(&arrange(&teams, saved.as_deref())),
    );
    Reply::new(response.status, body)
}

/// The Local Team list in the Supervisor's order, read from the order the configuration names.
///
/// # Errors
///
/// Never: a Team failure is its answer.
pub async fn listing(app: &App, team: &Team) -> Outcome {
    Ok(listing_at(team, &app.config.team_order_path).await)
}

/// Saves an exact permutation of the current Teams as their list order; the caller holds the order lock.
pub async fn reorder(team: &Team, path: &Path, team_ids: &[String]) -> Reply {
    let teams = match fresh_inventory(team).await {
        Ok(teams) => teams,
        Err(failure) => return failure,
    };
    let mut wanted: Vec<&String> = team_ids.iter().collect();
    let mut current: Vec<&String> = teams.iter().map(|team| &team.team_id).collect();
    wanted.sort();
    current.sort();
    if wanted != current {
        return Reply::new(
            409,
            json::detail_code(
                "The Team list changed; reload it and reorder again",
                "team-order-stale",
            ),
        );
    }
    if save(path, team_ids).is_err() {
        log("error", "team_order_save_failed");
        return unavailable("The Team order could not be saved; try again");
    }
    Reply::ok(json::object(vec![(
        "teams",
        bridge::inventory_value(&arrange(&teams, Some(team_ids))),
    )]))
}

/// Before Admin creates a Team id, durably drops a saved position the id kept from a Team that no longer exists.
///
/// The caller holds the order lock across this release and its creation; a refusal comes before anything is created.
pub async fn release_for_create(team: &Team, path: &Path, team_id: &str) -> Option<Reply> {
    let released: Result<Option<Reply>, OrderError> = async {
        let saved = match saved_for_mutation(path)? {
            Some(saved) if saved.iter().any(|item| item == team_id) => saved,
            _ => {
                sync_parent(path)?;
                return Ok(None);
            }
        };
        let teams = match fresh_inventory(team).await {
            Ok(teams) => teams,
            Err(failure) => return Ok(Some(failure)),
        };
        if teams.iter().all(|team| team.team_id != team_id) {
            let kept: Vec<String> = saved.into_iter().filter(|item| item != team_id).collect();
            save(path, &kept)?;
        }
        Ok(None)
    }
    .await;
    released.unwrap_or_else(|_| {
        log("error", "team_order_release_failed");
        Some(unavailable(
            "The Team order is unavailable, so no Team was created; try again",
        ))
    })
}

fn cleanup(
    response: Reply,
    action: impl FnOnce() -> Result<(), OrderError>,
    detail: &str,
) -> Reply {
    if !response.success() {
        return response;
    }
    if action().is_err() {
        log("error", "team_order_cleanup_unavailable");
        return Reply::new(
            503,
            json::detail_code(detail, "team-order-cleanup-incomplete"),
        );
    }
    response
}

/// After a successful Team deletion, which the caller holds the lock across, removes the Team's saved position.
#[must_use]
pub fn team_deleted(path: &Path, team_id: &str, response: Reply) -> Reply {
    cleanup(
        response,
        || forget(path, team_id),
        "The Team was deleted, but Admin could not remove its saved list position; retry the deletion",
    )
}

/// After a successful Space reset, which the caller holds the lock across, removes the saved order.
#[must_use]
pub fn space_reset(path: &Path, response: Reply) -> Reply {
    cleanup(
        response,
        || clear(path),
        "The Space was reset, but Admin could not remove the saved Team order; run the Space reset again",
    )
}

/// The Team ids a reorder request names.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn requested_ids(payload: &Value) -> Result<Vec<String>, Fault> {
    body::exact_fields(payload, &["team_ids"])?;
    canonical_ids(payload.get("team_ids").unwrap_or(&Value::Null)).ok_or_else(|| {
        Fault::detail(
            400,
            "team_ids must list at most 128 unique canonical Team ids",
        )
    })
}

#[cfg(test)]
mod tests;
