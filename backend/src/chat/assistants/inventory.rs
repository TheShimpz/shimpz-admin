//! Strict Team-owned Assistant inventory projections for chat lifecycle decisions.

use std::{collections::BTreeMap, sync::LazyLock};

use team_protocol::{
    payload::{ASSISTANT_VERSION_RE, MAX_TEAM_ASSISTANTS, canonical_assistant_details},
    python::regex::{Pattern, declared},
};

use super::proposal::Capability;
use crate::{
    chat::{
        catalog::store::{PLANNING_LOCALE, catalog_text},
        payloads,
    },
    fault::{Fault, Reply},
    json::{self, Value},
    team::{bridge, transport::Team},
};

/// The most Assistants an installed inventory lists.
pub const MAX_ASSISTANTS: usize = 128;
/// The most Actions per Assistant.
pub const MAX_ACTIONS_PER_ASSISTANT: usize = 128;
static RUNTIME_STATUS: LazyLock<Pattern> = LazyLock::new(|| declared(r"[a-z]{2,24}\Z"));

/// One installed Assistant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledAssistant {
    /// Its id.
    pub assistant_id: String,
    /// Its installed version.
    pub version: String,
    /// `local` or `published`.
    pub provenance: String,
    /// Its runtime status.
    pub status: String,
}

/// Installed Assistants by id.
pub type Installed = BTreeMap<String, InstalledAssistant>;

fn invalid() -> Fault {
    Fault::Internal
}

fn assistants(response: &Reply, maximum: usize) -> Result<&[Value], Fault> {
    if !response.success() || !bridge::traced_exactly(&response.body, &["assistants"]) {
        return Err(invalid());
    }
    response
        .get("assistants")
        .and_then(json::as_array)
        .filter(|items| items.len() <= maximum)
        .ok_or_else(invalid)
}

fn canonical_id(value: Option<&Value>) -> Result<String, Fault> {
    let value = value.ok_or_else(invalid)?;
    let id = payloads::assistant_id(value).map_err(|_| invalid())?;
    if json::as_str(value) == Some(id.as_str()) {
        Ok(id)
    } else {
        Err(invalid())
    }
}

/// The Team's installed Assistants.
///
/// # Errors
///
/// Returns [`Fault::Internal`] for an unavailable or invalid inventory.
pub fn installed(response: &Reply) -> Result<Installed, Fault> {
    let mut result = Installed::new();
    for item in assistants(response, MAX_ASSISTANTS)? {
        if !json::has_exactly(
            item,
            &["assistant", "assistant_version", "provenance", "status"],
        ) {
            return Err(invalid());
        }
        let assistant_id = canonical_id(item.get("assistant"))?;
        let version = json::get_str(item, "assistant_version")
            .filter(|version| ASSISTANT_VERSION_RE.is_full(version));
        let provenance = json::get_str(item, "provenance")
            .filter(|provenance| matches!(*provenance, "local" | "published"));
        let status = json::get_str(item, "status").filter(|status| RUNTIME_STATUS.is_full(status));
        let (Some(version), Some(provenance), Some(status)) = (version, provenance, status) else {
            return Err(invalid());
        };
        if result.contains_key(&assistant_id) {
            return Err(invalid());
        }
        result.insert(
            assistant_id.clone(),
            InstalledAssistant {
                assistant_id,
                version: version.to_owned(),
                provenance: provenance.to_owned(),
                status: status.to_owned(),
            },
        );
    }
    Ok(result)
}

/// The Team's installed Assistants, read from Team.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::Internal`] for an invalid inventory.
pub async fn installed_inventory(team: &Team, team_id: &str) -> Result<Installed, Fault> {
    installed(&bridge::list_installed_assistants(team, team_id).await?)
}

/// The first Creator the exact binding a Team runs declares; Team answers for the binding it runs, so its identity and
/// version must be the installed ones.
///
/// # Errors
///
/// Returns the Team request's fault, or [`Fault::Internal`] for anything else.
pub async fn binding_creator(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    version: &str,
) -> Result<String, Fault> {
    let response = bridge::assistant_details(team, team_id, assistant_id, PLANNING_LOCALE).await?;
    if response.status != 200 {
        return Err(invalid());
    }
    let body = json::without(&response.body, "trace_id");
    let details = canonical_assistant_details(&body).ok_or_else(invalid)?;
    if json::get_str(details, "locale") != Some(PLANNING_LOCALE)
        || json::get_str(details, "assistant_id") != Some(assistant_id)
        || json::get_str(details, "assistant_version") != Some(version)
    {
        return Err(invalid());
    }
    details
        .get("creators")
        .and_then(json::as_array)
        .and_then(<[Value]>::first)
        .and_then(json::as_str)
        .map(str::to_owned)
        .ok_or_else(invalid)
}

/// The Space's admissible Assistants by name: each identity once, with its catalog name.
///
/// # Errors
///
/// Returns [`Fault::Internal`] for an unavailable or invalid listing.
pub fn names(response: &Reply) -> Result<BTreeMap<String, String>, Fault> {
    let mut named = BTreeMap::new();
    for item in assistants(response, MAX_ASSISTANTS)? {
        if !json::has_exactly(item, &["id", "title"]) {
            return Err(invalid());
        }
        let id = canonical_id(item.get("id"))?;
        let title =
            catalog_text(item.get("title").unwrap_or(&Value::Null), 80).ok_or_else(invalid)?;
        if named.insert(id, title).is_some() {
            return Err(invalid());
        }
    }
    Ok(named)
}

fn actions(value: Option<&Value>) -> Result<Vec<String>, Fault> {
    let items = value
        .and_then(json::as_array)
        .filter(|items| (1..=MAX_ACTIONS_PER_ASSISTANT).contains(&items.len()))
        .ok_or_else(invalid)?;
    let actions: Vec<String> = items
        .iter()
        .map(|item| {
            let id = payloads::action_id(item).map_err(|_| invalid())?;
            if json::as_str(item) == Some(id.as_str()) {
                Ok(id)
            } else {
                Err(invalid())
            }
        })
        .collect::<Result<_, _>>()?;
    let mut unique = actions.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() == actions.len() {
        Ok(actions)
    } else {
        Err(invalid())
    }
}

/// One Team's admitted Assistants with the capabilities its own bindings declare.
///
/// # Errors
///
/// Returns [`Fault::Internal`] for an unavailable or invalid registry.
pub fn registry(response: &Reply) -> Result<BTreeMap<String, Capability>, Fault> {
    let mut capabilities = BTreeMap::new();
    for item in assistants(response, MAX_TEAM_ASSISTANTS)? {
        if !json::has_exactly(item, &["id", "title", "summary", "actions"]) {
            return Err(invalid());
        }
        let id = canonical_id(item.get("id"))?;
        let capability = Capability {
            assistant_id: id.clone(),
            name: catalog_text(item.get("title").unwrap_or(&Value::Null), 80)
                .ok_or_else(invalid)?,
            summary: catalog_text(item.get("summary").unwrap_or(&Value::Null), 80)
                .ok_or_else(invalid)?,
            actions: actions(item.get("actions"))?,
            integrations: Vec::new(),
        };
        if capabilities.insert(id, capability).is_some() {
            return Err(invalid());
        }
    }
    Ok(capabilities)
}
