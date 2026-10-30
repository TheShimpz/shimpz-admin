//! The Space's reset routes; every answer is never cached.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, header},
    response::Response,
};

use super::{host_reset, reset};
use crate::{
    fault::Fault,
    http::{body, browser, respond},
    process::app::App,
    team::transport::Team,
};

fn never_cached(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `DELETE /api/space`: the Supervisor resets the Space with the current password.
pub async fn space_reset(State(app): State<Arc<App>>, request: Request) -> Response {
    let origin = browser::request_origin(request.headers());
    let team = request.extensions().get::<Team>().cloned();
    let (parts, body) = request.into_parts();
    let outcome = async {
        let payload = body::json_object(&parts.headers, body, reset::MAX_BODY_BYTES).await?;
        let team = team.ok_or(Fault::Authority)?;
        reset::authenticated(&app, &team, origin.as_deref(), &payload).await
    }
    .await;
    respond::outcome(outcome)
}

/// `DELETE /api/space/host`: the host capability, with the password once the Space has a Supervisor.
pub async fn host_reset(State(app): State<Arc<App>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let outcome = async {
        let payload = body::json_object(&parts.headers, body, reset::MAX_BODY_BYTES).await?;
        host_reset::reset(&app, &payload).await
    }
    .await;
    never_cached(respond::outcome(outcome))
}
