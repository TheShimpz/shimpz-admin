//! Strict Team projection for one exact automatic Assistant installation.

use crate::{
    chat::catalog::{Offer, local::LocalAssistant, store::CatalogAssistant},
    fault::{Fault, Reply},
    json::{self, Value},
    process::app::App,
    team::{bridge, transport::Team},
};

/// Team's closed refusal of a fresh install beyond the Team's Assistant bound; Admin localizes it.
pub const ASSISTANT_LIMIT_REACHED: &str = "assistant_limit_reached";

/// What one install did: Team's status, whether it installed anything, and Team's closed refusal code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallResult {
    /// Team's status.
    pub status: u16,
    /// Whether it installed anything; `None` when it failed.
    pub installed: Option<bool>,
    /// Team's Assistant-limit refusal.
    pub code: Option<&'static str>,
}

/// Only Team's closed Assistant-limit refusal; any other failure stays a bare status.
#[must_use]
pub fn limit_code(status: u16, body: &Value) -> Option<&'static str> {
    (status == 409 && json::get_str(body, "code") == Some(ASSISTANT_LIMIT_REACHED))
        .then_some(ASSISTANT_LIMIT_REACHED)
}

fn result(response: &Reply, installed: impl Fn(&Value) -> Option<bool>) -> InstallResult {
    if !response.success() {
        return InstallResult {
            status: response.status,
            installed: None,
            code: limit_code(response.status, &response.body),
        };
    }
    installed(&response.body).map_or(
        InstallResult {
            status: 502,
            installed: None,
            code: None,
        },
        |installed| InstallResult {
            status: response.status,
            installed: Some(installed),
            code: None,
        },
    )
}

fn installed_flag(body: &Value) -> Option<bool> {
    match body.get("installed") {
        Some(Value::Bool(installed)) => Some(*installed),
        _ => None,
    }
}

fn publication_body(body: &Value, assistant_id: &str) -> Option<bool> {
    (bridge::traced_exactly(body, &["assistant", "installed"])
        && json::get_str(body, "assistant") == Some(assistant_id))
    .then(|| installed_flag(body))
    .flatten()
}

fn local_body(body: &Value, assistant: &LocalAssistant) -> Option<bool> {
    let valid = bridge::traced_exactly(
        body,
        &[
            "assistant",
            "installed",
            "provenance",
            "image_id",
            "unpublished",
        ],
    ) && json::get_str(body, "assistant") == Some(assistant.assistant_id.as_str())
        && json::get_str(body, "image_id") == Some(assistant.image_id.as_str())
        && json::get_str(body, "provenance") == Some("local")
        && body.get("unpublished") == Some(&Value::Bool(true));
    valid.then(|| installed_flag(body)).flatten()
}

async fn install_publication(
    app: &App,
    team: &Team,
    team_id: &str,
    assistant: &CatalogAssistant,
) -> Result<InstallResult, Fault> {
    let payload = json::object(vec![
        ("assistant_id", json::text(&assistant.assistant_id)),
        ("source_digest", json::text(&assistant.source_digest)),
    ]);
    let response = bridge::install_assistant(team, &app.topics, team_id, &payload).await?;
    Ok(result(&response, |body| {
        publication_body(body, &assistant.assistant_id)
    }))
}

async fn install_local_snapshot(
    app: &App,
    team: &Team,
    team_id: &str,
    assistant: &LocalAssistant,
) -> Result<InstallResult, Fault> {
    let payload = json::object(vec![("image_id", json::text(&assistant.image_id))]);
    let response =
        bridge::install_fresh_local_assistant(team, &app.topics, team_id, &payload).await?;
    Ok(result(&response, |body| local_body(body, assistant)))
}

/// Submits one exact selection to Team's verifying lifecycle: a publication, or a staged snapshot fresh-only.
///
/// # Errors
///
/// Returns the Team request's fault.
pub async fn install(
    app: &App,
    team: &Team,
    team_id: &str,
    offer: &Offer,
) -> Result<InstallResult, Fault> {
    match offer {
        Offer::Published(assistant) => install_publication(app, team, team_id, assistant).await,
        Offer::Local(assistant) => install_local_snapshot(app, team, team_id, assistant).await,
    }
}
