//! Store, local, and installed Assistants.

use team_protocol::payload::MAX_TEAM_REGISTRY_BYTES;

use super::{ASSISTANT_INSTALL_TIMEOUT, changed, source_digest};
use crate::team::transport::{self, AssetReply, Image, Options, Team};
use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
    session::topics::Topics,
};

/// Every admissible Assistant of the Space by identity and name.
pub async fn list_assistants(team: &Team) -> Reply {
    team.call("GET", "/v1/assistants", None)
        .await
        .unwrap_or_else(|_| transport::unavailable())
}

/// One Team's admitted Assistants with the names, summaries, and Actions its own bindings declare.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn team_assistant_registry(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    team.call_with(
        "GET",
        &format!("/v1/teams/{id}/assistant-registry"),
        None,
        Options {
            response_limit: MAX_TEAM_REGISTRY_BYTES,
            ..Options::default()
        },
    )
    .await
}

/// The unpublished snapshots the Local Team exposes.
pub async fn list_local_assistants(team: &Team) -> Reply {
    team.call("GET", "/v1/local-assistants", None)
        .await
        .unwrap_or_else(|_| transport::unavailable())
}

fn local_assistant_path(image_id: &str) -> Result<String, Fault> {
    let digest = source_digest(&json::text(image_id))?;
    Ok(format!(
        "/v1/local-assistants/{}",
        digest.trim_start_matches("sha256:")
    ))
}

/// One exact unpublished image's admitted PNG preview.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id.
pub async fn local_assistant_icon(team: &Team, image_id: &str) -> Result<AssetReply, Fault> {
    let path = local_assistant_path(image_id)?;
    Ok(team.call_image(&format!("{path}/icon"), Image::Icon).await)
}

/// One exact unpublished image's summary in one interface language, from its own pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id or locale.
pub async fn local_assistant_summary(
    team: &Team,
    image_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = local_assistant_path(image_id)?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/summary/{locale}"), None)
        .await
}

/// One exact unpublished image's page in one interface language.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid image id or locale.
pub async fn local_assistant_details(
    team: &Team,
    image_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = local_assistant_path(image_id)?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/details/{locale}"), None)
        .await
}

fn assistant_path(team_id: &str, assistant_id: Option<&str>) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let base = format!("/v1/teams/{id}/assistants");
    match assistant_id {
        None => Ok(base),
        Some(assistant) => Ok(format!(
            "{base}/{}",
            payloads::assistant_id(&json::text(assistant))?
        )),
    }
}

/// The Team's installed Assistants.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list_installed_assistants(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    team.call("GET", &assistant_path(team_id, None)?, None)
        .await
}

/// One installed Assistant's icon.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn assistant_icon(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
) -> Result<AssetReply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    Ok(team.call_image(&format!("{path}/icon"), Image::Icon).await)
}

/// One installed Assistant's summary in one interface language, from its binding's pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or locale.
pub async fn assistant_summary(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/summary/{locale}"), None)
        .await
}

/// One installed Assistant's page in one interface language, from its exact binding and pack.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or locale.
pub async fn assistant_details(
    team: &Team,
    team_id: &str,
    assistant_id: &str,
    locale: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let locale = payloads::locale(&json::text(locale))?;
    team.call("GET", &format!("{path}/details/{locale}"), None)
        .await
}

fn install_options() -> Options {
    Options {
        timeout: ASSISTANT_INSTALL_TIMEOUT,
        ..Options::default()
    }
}

/// Installs one exact public Store selection; a committed install raises the Team's inventory topics.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    if !json::has_exactly(payload, &["assistant_id", "source_digest"]) {
        return Err(Fault::team_request(
            "request body must contain only assistant_id and source_digest",
        ));
    }
    let assistant = payloads::assistant_id(payload.get("assistant_id").unwrap_or(&Value::Null))?;
    let digest = source_digest(payload.get("source_digest").unwrap_or(&Value::Null))?;
    let path = assistant_path(team_id, None)?;
    let response = team
        .call_with(
            "POST",
            &path,
            Some(&json::object(vec![
                ("assistant_id", json::text(assistant)),
                ("source_digest", json::text(digest)),
            ])),
            install_options(),
        )
        .await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}

async fn install_local(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
    route: &str,
) -> Result<Reply, Fault> {
    if !json::has_exactly(payload, &["image_id"]) {
        return Err(Fault::team_request(
            "request body must contain only image_id",
        ));
    }
    let image = source_digest(payload.get("image_id").unwrap_or(&Value::Null))?;
    let path = assistant_path(team_id, None)?;
    let response = team
        .call_with(
            "POST",
            &format!("{path}/{route}"),
            Some(&json::object(vec![("image_id", json::text(image))])),
            install_options(),
        )
        .await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}

/// Installs one exact staged image.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_local_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    install_local(team, topics, team_id, payload, "local").await
}

/// Installs one exact staged image only when the Team does not hold that Assistant yet.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or payload.
pub async fn install_fresh_local_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    payload: &Value,
) -> Result<Reply, Fault> {
    install_local(team, topics, team_id, payload, "local/fresh").await
}

/// Uninstalls one Assistant.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn uninstall_assistant(
    team: &Team,
    topics: &Topics,
    team_id: &str,
    assistant_id: &str,
) -> Result<Reply, Fault> {
    let path = assistant_path(team_id, Some(assistant_id))?;
    let response = team.call("DELETE", &path, None).await?;
    let id = payloads::team_id(&json::text(team_id))?;
    Ok(changed(
        response,
        topics,
        &id,
        &["inventory", "integrations"],
        true,
    ))
}
