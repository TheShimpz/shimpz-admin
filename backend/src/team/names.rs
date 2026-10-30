//! Local Team names (ADR-0088): create under a free id, rename without changing the id, and delete by exact name.
//!
//! Each operation that changed the Team list raises its `teams` topic for the session sockets that show it.

use unicode_normalization::UnicodeNormalization;

use super::{bridge, history, order, transport::Team};
use crate::{
    app::App,
    command::log,
    fault::{Fault, Outcome, Reply},
    http::body,
    json::{self, Value},
    signin::password::MAX_PASSWORD_CHARS,
};

/// A recreated name whose id a renamed Team still holds gets the next free suffix: `marketing_2` … `_9`.
pub const MAX_ID_SUFFIX: usize = 9;
/// The characters of the id a suffix is appended to.
pub const ID_SUFFIX_BASE_CHARS: usize = 38;

fn team_name(payload: &Value) -> Result<String, Fault> {
    body::exact_fields(payload, &["team_name"])?;
    let name = payload
        .get("team_name")
        .and_then(json::as_str)
        .ok_or_else(|| Fault::detail(400, "team name must be a string"))?;
    let normalized: String = team_protocol::python::text::strip(name).nfc().collect();
    bridge::local_team_name(&json::text(normalized)).map_err(Fault::bad_request)
}

/// The name's id, then its suffixed ids.
///
/// # Errors
///
/// Returns 400 for a name with no usable characters.
pub fn candidate_ids(team_name: &str) -> Result<Vec<String>, Fault> {
    let base = bridge::to_team_id(team_name);
    if base.is_empty() {
        return Err(Fault::detail(400, "team name has no usable characters"));
    }
    let stem: String = base.chars().take(ID_SUFFIX_BASE_CHARS).collect();
    let stem = stem.trim_end_matches('_').to_owned();
    let mut ids = vec![base];
    ids.extend((2..=MAX_ID_SUFFIX).map(|suffix| format!("{stem}_{suffix}")));
    Ok(ids)
}

/// Tries the name's id, then its suffixes, only while each is held by a Team with another current name.
async fn create_free(app: &App, team: &Team, team_name: &str) -> Result<(String, Reply), Fault> {
    let path = &app.config.team_order_path;
    let _order = app.domains.team.order.lock().await;
    let mut last = None;
    for team_id in candidate_ids(team_name)? {
        let response = match order::release_for_create(team, path, &team_id).await {
            Some(refusal) => refusal,
            None => bridge::create(team, &team_id, team_name).await?,
        };
        if response.status != 409 || response.get_str("code") != Some("team-name-conflict") {
            return Ok((team_id, response));
        }
        last = Some((team_id, response));
    }
    Ok(last.unwrap_or_else(|| (String::new(), crate::team::transport::unavailable())))
}

fn changed(app: &App, response: Reply) -> Reply {
    if response.success() {
        app.topics.changed("teams");
    }
    response
}

/// `teams.create`.
///
/// # Errors
///
/// Returns 400 for an invalid name, or the Team request's fault.
pub async fn create(app: &App, team: &Team, payload: &Value) -> Outcome {
    let name = team_name(payload)?;
    let (team_id, result) = create_free(app, team, &name).await?;
    let result = if result.get("created") == Some(&Value::Bool(true)) {
        history::cleanup(result, || history::clear_team(app, &team_id))
    } else {
        result
    };
    if result.success() {
        log("info", "team_created");
    }
    Ok(changed(app, result))
}

/// `teams.rename`.
///
/// # Errors
///
/// Returns 400 for an invalid name or id.
pub async fn rename(app: &App, team: &Team, team_id: &str, payload: &Value) -> Outcome {
    let name = team_name(payload)?;
    let response = bridge::rename(team, team_id, &name)
        .await
        .map_err(Fault::bad_request)?;
    Ok(changed(app, response))
}

/// The exact Team name and Supervisor password a deletion confirms, as the browser sent them.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn deletion(payload: &Value) -> Result<(String, Value), Fault> {
    body::exact_fields(payload, &["team_name", "password"])?;
    let (Some(name), Some(password)) = (
        payload.get("team_name").and_then(json::as_str),
        payload.get("password").and_then(json::as_str),
    ) else {
        return Err(Fault::detail(400, "Team name and password must be strings"));
    };
    if !(1..=MAX_PASSWORD_CHARS).contains(&password.chars().count()) {
        return Err(Fault::detail(400, "Supervisor password is invalid"));
    }
    Ok((name.to_owned(), json::text(password)))
}

/// Deletes the Team its exact current name confirms, with its history and its saved list position.
///
/// # Errors
///
/// Returns 400 for an invalid id or name.
pub async fn delete(app: &App, team: &Team, team_id: &str, team_name: &str) -> Outcome {
    let _order = app.domains.team.order.lock().await;
    let response = {
        let _history = history::lifecycle(app).await;
        let mut response = bridge::destroy_confirmed(team, team_id, team_name)
            .await
            .map_err(Fault::bad_request)?;
        if response.status == 404 && json::equal(&response.body, &json::detail("Team not found")) {
            response = Reply::ok(json::object(vec![("deleted", Value::Bool(false))]));
        }
        history::cleanup(response, || history::clear_team(app, team_id))
    };
    let response = order::team_deleted(&app.config.team_order_path, team_id, response);
    Ok(changed(app, response))
}

#[cfg(test)]
mod tests;
