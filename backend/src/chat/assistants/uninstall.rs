//! Strict Team projections and execution for conversational Assistant uninstall.

use super::{
    inventory::{self, Installed},
    proposal::{Capability, UninstallCandidate, UninstallProposal},
};
use crate::{
    app::App,
    fault::{Fault, Reply},
    json::{self, Value},
    team::{bridge, transport::Team},
};

/// What one uninstall did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallResult {
    /// Team's status.
    pub status: u16,
    /// Whether it uninstalled anything; `None` when it failed.
    pub uninstalled: Option<bool>,
}

/// The installed Assistants a chat request may name, and which of them the current contract refuses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UninstallDirectory {
    /// Every installed Assistant, by id.
    pub candidates: Vec<UninstallCandidate>,
    /// The ones whose binding the current contract refuses.
    pub refused: Vec<String>,
}

/// The exact installed Assistant directory from strict Team-owned state. A binding the current contract refuses stays
/// listed under its identity, so a request naming it is answered with guidance; any other installed Assistant missing
/// from the Team's registry means the two disagree, and nothing is offered.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::Internal`] for a directory that is not authoritative.
pub async fn candidates(team: &Team, team_id: &str) -> Result<UninstallDirectory, Fault> {
    let installed: Installed = inventory::installed_inventory(team, team_id).await?;
    let registry = inventory::registry(&bridge::team_assistant_registry(team, team_id).await?)?;
    let refused: Vec<String> = installed
        .iter()
        .filter(|(id, item)| !registry.contains_key(*id) && item.status == "invalid")
        .map(|(id, _)| id.clone())
        .collect();
    if installed
        .keys()
        .any(|id| !registry.contains_key(id) && !refused.contains(id))
    {
        return Err(Fault::Internal);
    }
    let candidates = installed
        .iter()
        .map(|(id, item)| UninstallCandidate {
            assistant: registry.get(id).cloned().unwrap_or_else(|| Capability {
                assistant_id: id.clone(),
                name: id.clone(),
                summary: String::new(),
                actions: Vec::new(),
                integrations: Vec::new(),
            }),
            version: item.version.clone(),
            provenance: item.provenance.clone(),
        })
        .collect();
    Ok(UninstallDirectory {
        candidates,
        refused,
    })
}

fn project(response: &Reply, assistant_id: &str) -> UninstallResult {
    if !response.success() {
        return UninstallResult {
            status: response.status,
            uninstalled: None,
        };
    }
    let body = &response.body;
    let uninstalled = match body.get("uninstalled") {
        Some(Value::Bool(uninstalled))
            if bridge::traced_exactly(body, &["assistant", "uninstalled"])
                && json::get_str(body, "assistant") == Some(assistant_id) =>
        {
            Some(*uninstalled)
        }
        _ => None,
    };
    UninstallResult {
        status: if uninstalled.is_some() {
            response.status
        } else {
            502
        },
        uninstalled,
    }
}

/// Revalidates the proposed version, then invokes only Team's uninstall authority.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::Internal`] for an invalid inventory.
pub async fn uninstall(
    app: &App,
    team: &Team,
    proposal: &UninstallProposal,
) -> Result<UninstallResult, Fault> {
    let installed = inventory::installed_inventory(team, &proposal.team_id).await?;
    let assistant_id = &proposal.assistant.assistant_id;
    Ok(match installed.get(assistant_id) {
        None => UninstallResult {
            status: 200,
            uninstalled: Some(false),
        },
        Some(current) if current.version != proposal.assistant_version => UninstallResult {
            status: 409,
            uninstalled: None,
        },
        Some(_) => {
            let response =
                bridge::uninstall_assistant(team, &app.topics, &proposal.team_id, assistant_id)
                    .await?;
            project(&response, assistant_id)
        }
    })
}
