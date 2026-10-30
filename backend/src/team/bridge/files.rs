//! Team files and the Browser view.

use team_protocol::{
    browser_view as view_contract,
    payload::{self as team_contract},
    preview,
};

use super::{MAX_PREVIEW_RETRY_MS, closed_traced};
use crate::team::transport::{self, AssetReply, Image, Team};
use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
};

fn files_path(team_id: &str, file_id: Option<&str>) -> Result<String, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let base = format!("/v1/teams/{id}/files");
    match file_id {
        None => Ok(base),
        Some(file) => Ok(format!("{base}/{}", payloads::file_id(&json::text(file))?)),
    }
}

fn project_storage(response: &Reply, team_id: &str, kind: &str) -> Reply {
    if !response.success() {
        let mut error: Vec<(&str, Value)> = Vec::new();
        for key in ["detail", "error", "code"] {
            if let Some(text) = response
                .get_str(key)
                .filter(|text| (1..=500).contains(&team_protocol::python::text::len(text)))
            {
                error.push((key, json::text(text)));
            }
        }
        if error.is_empty() {
            error.push(("detail", json::text("team request failed")));
        }
        return Reply::new(response.status, json::object(error));
    }
    match team_contract::project_storage_response(&response.body, kind, team_id) {
        Some(body) => Reply::new(response.status, body),
        None => transport::unavailable(),
    }
}

/// Uploads one file's bytes to the Team, named and typed as Team admits them.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id, name, type, or size.
pub async fn upload_file(
    team: &Team,
    team_id: &str,
    filename: &str,
    media_type: &str,
    content: &[u8],
) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let name = team_contract::canonical_filename(&json::text(filename))
        .map(str::to_owned)
        .ok_or_else(|| Fault::team_request("filename must be a trimmed, non-path UTF-8 name"))?;
    let kind = team_contract::canonical_media_type(&json::text(media_type))
        .ok_or_else(|| Fault::team_request("invalid media type"))?;
    let limit = usize::try_from(team_contract::MAX_FILE_UPLOAD_BYTES).unwrap_or(usize::MAX);
    if content.is_empty() {
        return Err(Fault::team_request("file must contain bytes"));
    }
    if content.len() > limit {
        return Err(Fault::team_request(format!("file exceeds {limit} bytes")));
    }
    let response = team
        .call_raw("POST", &files_path(&id, None)?, content, &name, &kind)
        .await;
    Ok(project_storage(&response, &id, "upload"))
}

/// The Team's files and storage usage.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list_files(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team.call("GET", &files_path(&id, None)?, None).await?;
    Ok(project_storage(&response, &id, "list"))
}

const PREVIEW_REFUSALS: &[(u16, &[&str])] = &[
    (404, &["file-not-found", "team-not-found"]),
    (422, &["file-preview-unsupported"]),
    (503, &["file-preview-busy", "file-preview-unavailable"]),
];
const CONTENT_REFUSALS: &[(u16, &[&str])] = &[
    (403, &["file-acknowledgement-required"]),
    (404, &["file-not-found", "team-not-found"]),
    (503, &["file-download-busy"]),
];
const ACKNOWLEDGEMENT_REFUSALS: &[(u16, &[&str])] = &[
    (403, &["file-acknowledgement-required"]),
    (404, &["file-not-found", "team-not-found"]),
    (409, &["file-not-from-web"]),
];
const VIEW_REFUSALS: &[(u16, &[&str])] = &[
    (404, &[view_contract::NOT_RUNNING, "team-not-found"]),
    (503, &[view_contract::BUSY, view_contract::UNAVAILABLE]),
];

fn closed_code<'a>(
    refusals: &[(u16, &[&str])],
    status: u16,
    code: Option<&'a str>,
) -> Option<&'a str> {
    let code = code?;
    refusals
        .iter()
        .any(|(known, codes)| *known == status && codes.contains(&code))
        .then_some(code)
}

fn file_bytes(response: AssetReply, refusals: &[(u16, &[&str])], detail: &str) -> AssetReply {
    if response.contents.is_some() {
        return response;
    }
    let code = json::get_str(&response.error, "code");
    let Some(code) = closed_code(refusals, response.status, code) else {
        return AssetReply::unavailable();
    };
    let mut error = vec![("detail", json::text(detail)), ("code", json::text(code))];
    let retry = response.error.get("retry_after_ms").and_then(json::as_int);
    if matches!(code, "file-preview-busy" | "file-download-busy")
        && let Some(retry) = retry.filter(|retry| (1..=MAX_PREVIEW_RETRY_MS).contains(retry))
    {
        error.push(("retry_after_ms", json::int(retry)));
    }
    AssetReply {
        error: json::object(error),
        ..response
    }
}

/// One Team file's sanitized image rendition, or its closed refusal (ADR-0093).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn file_preview(team: &Team, team_id: &str, file_id: &str) -> Result<AssetReply, Fault> {
    let path = files_path(team_id, Some(file_id))?;
    let response = team
        .call_image(&format!("{path}/preview"), Image::Preview)
        .await;
    Ok(file_bytes(
        response,
        PREVIEW_REFUSALS,
        "file preview unavailable",
    ))
}

/// One page of a Team PDF as a sanitized rendition with its page count, or its closed refusal.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or page.
pub async fn file_page_preview(
    team: &Team,
    team_id: &str,
    file_id: &str,
    page: &str,
) -> Result<AssetReply, Fault> {
    let page = preview::canonical_page(&json::text(page))
        .ok_or_else(|| Fault::team_request("page must be a number from 1 to 50"))?;
    let path = files_path(team_id, Some(file_id))?;
    let response = team
        .call_image(&format!("{path}/pages/{page}/preview"), Image::PagePreview)
        .await;
    Ok(file_bytes(
        response,
        PREVIEW_REFUSALS,
        "file preview unavailable",
    ))
}

/// Records the Supervisor's acknowledgement of one file from the web before its original is saved.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn acknowledge_file(team: &Team, team_id: &str, file_id: &str) -> Result<Reply, Fault> {
    let file = payloads::file_id(&json::text(file_id))?;
    let path = files_path(team_id, Some(&file))?;
    let response = team
        .call("POST", &format!("{path}/acknowledgement"), None)
        .await?;
    let expected = json::object(vec![
        ("file_id", json::text(&file)),
        ("acknowledged", Value::Bool(true)),
    ]);
    if response.status == 200 && json::equal(&response.body, &expected) {
        return Ok(response);
    }
    Ok(
        match closed_code(
            ACKNOWLEDGEMENT_REFUSALS,
            response.status,
            response.get_str("code"),
        ) {
            Some(code) => Reply::new(
                response.status,
                json::detail_code("file acknowledgement unavailable", code),
            ),
            None => transport::unavailable(),
        },
    )
}

/// One Team file's original, verified against its digest, or its closed refusal.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn file_content(team: &Team, team_id: &str, file_id: &str) -> Result<AssetReply, Fault> {
    let path = files_path(team_id, Some(file_id))?;
    let response = team.call_content(&format!("{path}/content")).await;
    Ok(file_bytes(
        response,
        CONTENT_REFUSALS,
        "file download unavailable",
    ))
}

/// The view id of the Browser task the Team runs now, for the Supervisor to watch its screen.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn open_browser_view(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let id = payloads::team_id(&json::text(team_id))?;
    let response = team
        .call("POST", &format!("/v1/teams/{id}/browser/view"), None)
        .await?;
    if response.status == 200 && closed_traced(&response.body, &["view_id"]) {
        let view = json::object(vec![(
            "view_id",
            response.get("view_id").cloned().unwrap_or(Value::Null),
        )]);
        if view_contract::canonical_view(&view).is_some() {
            return Ok(Reply::ok(view));
        }
    }
    Ok(
        match closed_code(VIEW_REFUSALS, response.status, response.get_str("code")) {
            Some(code) => Reply::new(
                response.status,
                json::detail_code("browser view unavailable", code),
            ),
            None => transport::unavailable(),
        },
    )
}
