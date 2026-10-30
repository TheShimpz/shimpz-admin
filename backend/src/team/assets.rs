//! Same-origin projection of verified binary assets Team holds: an installed Assistant's icon and a staged snapshot's.

use axum::{
    body::Body,
    extract::{Path, Request},
    http::{HeaderValue, StatusCode, header},
    response::Response,
};

use super::{bridge, transport::AssetReply};
use crate::{fault::Fault, http::respond, team::transport::Team};

fn image(result: Result<AssetReply, Fault>) -> Response {
    let result = match result {
        Ok(result) => result,
        Err(fault) => return respond::fault(&fault.bad_request()),
    };
    let Some(contents) = result.contents else {
        return respond::json_response(result.status, &result.error);
    };
    let mut response = Response::new(Body::from(contents));
    *response.status_mut() = StatusCode::from_u16(result.status).unwrap_or(StatusCode::OK);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn team_of(request: &Request) -> Result<Team, Fault> {
    request
        .extensions()
        .get::<Team>()
        .cloned()
        .ok_or(Fault::Authority)
}

/// `GET /api/teams/{team_id}/assistants/{assistant_id}/icon`.
pub async fn assistant_icon(
    Path((team_id, assistant_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    let result = match team_of(&request) {
        Ok(team) => bridge::assistant_icon(&team, &team_id, &assistant_id).await,
        Err(fault) => Err(fault),
    };
    image(result)
}

/// `GET /api/local-assistants/{image_hash}/icon`.
pub async fn local_assistant_icon(Path(image_hash): Path<String>, request: Request) -> Response {
    let result = match team_of(&request) {
        Ok(team) => bridge::local_assistant_icon(&team, &format!("sha256:{image_hash}")).await,
        Err(fault) => Err(fault),
    };
    image(result)
}
