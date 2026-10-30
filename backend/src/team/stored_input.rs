//! Metadata-only bridge for Team-owned persistent Action inputs (Stored Inputs): their inventory and clearing one.

use super::{bridge::closed_traced, transport::Team};
use crate::{
    chat::payloads,
    command::log,
    fault::{Fault, Reply},
    json::{self, Value},
    session::topics::Topics,
};

/// The most Stored Inputs a Team lists.
pub const MAX_STORED_INPUTS: usize = 128;
const STATUSES: [&str; 2] = ["missing", "stored"];

fn inventory_item(item: &Value) -> Option<(String, String, String)> {
    if !json::has_exactly(item, &["assistant_id", "stored_input_id", "status"]) {
        return None;
    }
    let assistant = payloads::assistant_id(item.get("assistant_id")?).ok()?;
    let stored = payloads::identifier(item.get("stored_input_id")?).ok()?;
    let status = json::get_str(item, "status").filter(|status| STATUSES.contains(status))?;
    Some((assistant, stored, status.to_owned()))
}

fn inventory(body: &Value, team_id: &str) -> Option<Value> {
    if !closed_traced(body, &["team_id", "stored_inputs"])
        || json::get_str(body, "team_id") != Some(team_id)
    {
        return None;
    }
    let items = body
        .get("stored_inputs")
        .and_then(json::as_array)
        .filter(|items| items.len() <= MAX_STORED_INPUTS)?;
    let mut listed: Vec<(String, String, String)> = Vec::with_capacity(items.len());
    for item in items {
        let entry = inventory_item(item)?;
        if listed
            .iter()
            .any(|known| (&known.0, &known.1) == (&entry.0, &entry.1))
        {
            return None;
        }
        listed.push(entry);
    }
    if !listed
        .windows(2)
        .all(|pair| (&pair[0].0, &pair[0].1) <= (&pair[1].0, &pair[1].1))
    {
        return None;
    }
    Some(Value::Array(
        listed
            .into_iter()
            .map(|(assistant, stored, status)| {
                json::object(vec![
                    ("assistant_id", json::text(assistant)),
                    ("stored_input_id", json::text(stored)),
                    ("status", json::text(status)),
                ])
            })
            .collect(),
    ))
}

/// `stored_inputs.list`: the Team's Stored Inputs, metadata only.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team
        .call(
            "GET",
            &format!("/v1/teams/{id}/assistant-stored-inputs"),
            None,
        )
        .await?;
    if !response.success() {
        return Ok(response);
    }
    if let Some(items) = inventory(&response.body, &id) {
        return Ok(Reply::ok(json::object(vec![("stored_inputs", items)])));
    }
    log("warning", "team_stored_input_inventory_invalid");
    Ok(Reply::detail(
        502,
        "Assistant Stored Input inventory is invalid.",
    ))
}

/// `stored_inputs.clear`: clears one Stored Input; a clear Team confirms raises the Team's `integrations` topic.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn clear(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    assistant_id: &str,
    stored_input_id: &str,
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let assistant = payloads::assistant_id(&json::text(assistant_id))?;
    let stored = payloads::identifier(&json::text(stored_input_id))?;
    let response = team
        .call(
            "DELETE",
            &format!("/v1/teams/{id}/assistant-stored-inputs/{assistant}/{stored}"),
            None,
        )
        .await?;
    if !response.success() {
        return Ok(response);
    }
    let body = &response.body;
    let cleared = body
        .get("cleared")
        .filter(|value| matches!(value, Value::Bool(_)));
    let admitted = response.status == 200
        && closed_traced(
            body,
            &["team_id", "assistant_id", "stored_input_id", "cleared"],
        )
        && json::get_str(body, "team_id") == Some(id.as_str())
        && json::get_str(body, "assistant_id") == Some(assistant.as_str())
        && json::get_str(body, "stored_input_id") == Some(stored.as_str());
    if let Some(cleared) = cleared.filter(|_| admitted) {
        topics.team_changed(&id, &["integrations"]);
        return Ok(Reply::ok(json::object(vec![("cleared", cleared.clone())])));
    }
    log("warning", "team_stored_input_clear_invalid");
    Ok(Reply::detail(
        502,
        "Assistant Stored Input clear response is invalid.",
    ))
}

#[cfg(test)]
mod tests;
