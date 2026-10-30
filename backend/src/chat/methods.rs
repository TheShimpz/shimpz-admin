//! The chat, history, catalog, and Integration methods of the session socket, each answering exactly as its HTTP
//! route did, on the session's call lanes or the catalog's own single-worker lane.

use std::sync::Arc;

use super::assets;
use crate::{
    fault::{Fault, Outcome, Reply},
    history,
    integrations::{assistants, authorization},
    json,
    session::calls::{Call, Run},
    team::bridge,
};

fn optional(call: &Call, name: &str) -> Option<String> {
    json::as_str(call.param(name)).map(str::to_owned)
}

/// `history.page`.
///
/// # Errors
///
/// Returns 400 for a refused request or 503 when the history is unavailable.
pub async fn history_page(call: &Call) -> Outcome {
    let (app, team) = (Arc::clone(call.app()), call.team()?);
    let (team_id, before, routine) = (
        call.text("team_id").to_owned(),
        optional(call, "before"),
        optional(call, "routine"),
    );
    call.on_lane(async move {
        history::http::page(&app.domains.history, &team, &team_id, before, routine).await
    })
    .await
}

/// A committed chat limit answer the Space's chat gate follows at once (ADR-0119).
fn followed(app: &crate::process::app::App, reply: Reply) -> Reply {
    if reply.status == 200
        && let Some(limit) = reply.get("limit").and_then(json::as_int)
    {
        app.domains.chat.gate.set_limit(limit);
    }
    reply
}

/// `chat_limit.read`.
///
/// # Errors
///
/// Returns the call's fault.
pub async fn chat_limit_read(call: &Call) -> Outcome {
    let team = call.team()?;
    let reply = call
        .on_lane(async move { Ok(bridge::chat_limit(&team).await) })
        .await?;
    Ok(followed(call.app(), reply))
}

/// `chat_limit.save`.
///
/// # Errors
///
/// Returns 400 for a limit outside its bounds.
pub async fn chat_limit_save(call: &Call) -> Outcome {
    let (app, team, body) = (Arc::clone(call.app()), call.team()?, call.body().clone());
    let reply = call
        .on_lane(async move {
            bridge::save_chat_limit(&team, &app.topics, &body)
                .await
                .map_err(Fault::bad_request)
        })
        .await?;
    Ok(followed(call.app(), reply))
}

/// `store.catalog`: one catalog page on the catalog's own single-worker lane, 503 when busy.
///
/// # Errors
///
/// Returns the page's refusal.
pub async fn store_catalog(call: &Call) -> Outcome {
    let app = Arc::clone(call.app());
    let (locale, cursor) = (call.text("locale").to_owned(), optional(call, "cursor"));
    let lane = &call.app().domains.chat.lanes.catalog;
    call.run(
        Run {
            lane,
            full: assets::catalog_full(),
            announce: false,
        },
        async move { assets::catalog_page(&app, &locale, cursor.as_deref()).await },
    )
    .await
}

/// `integrations.list`.
///
/// # Errors
///
/// Returns 400 for an invalid Team id.
pub async fn integrations_list(call: &Call) -> Outcome {
    let (team, team_id) = (call.team()?, call.text("team_id").to_owned());
    call.on_lane(async move {
        assistants::list_assistant_integrations(&team, &team_id)
            .await
            .map_err(Fault::bad_request)
    })
    .await
}

/// `integrations.authorize`: the callback mode follows the Origin the socket is bound to.
///
/// # Errors
///
/// Returns the authorization's refusal.
pub async fn integrations_authorize(call: &Call) -> Outcome {
    let (app, team) = (Arc::clone(call.app()), call.team()?);
    let (team_id, challenge_id, body) = (
        call.text("team_id").to_owned(),
        call.text("challenge_id").to_owned(),
        call.body().clone(),
    );
    let (session, origin) = (
        call.socket.cookie().to_owned(),
        call.socket.origin().to_owned(),
    );
    call.on_lane(async move {
        let request = authorization::Authorize {
            team_id: &team_id,
            challenge_id: &challenge_id,
            payload: &body,
            session: &session,
            origin: &origin,
        };
        authorization::authorize(&app, &team, &request).await
    })
    .await
}

/// `integrations.complete`.
///
/// # Errors
///
/// Returns the completion's refusal.
pub async fn integrations_complete(call: &Call) -> Outcome {
    let (app, team) = (Arc::clone(call.app()), call.team()?);
    let (team_id, challenge_id, body) = (
        call.text("team_id").to_owned(),
        call.text("challenge_id").to_owned(),
        call.body().clone(),
    );
    let session = call.socket.cookie().to_owned();
    call.on_lane(async move {
        authorization::complete(&app, &team, &team_id, &challenge_id, &body, &session).await
    })
    .await
}

/// `integrations.cancel`.
///
/// # Errors
///
/// Returns the cancellation's refusal.
pub async fn integrations_cancel(call: &Call) -> Outcome {
    let (app, team) = (Arc::clone(call.app()), call.team()?);
    let (team_id, challenge_id) = (
        call.text("team_id").to_owned(),
        call.text("challenge_id").to_owned(),
    );
    let session = call.socket.cookie().to_owned();
    call.on_lane(async move {
        authorization::cancel(&app, &team, &team_id, &challenge_id, &session).await
    })
    .await
}
