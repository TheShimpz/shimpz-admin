//! The Supervisor's authorization of one Assistant Integration challenge, as session calls (ADR-0114).
//!
//! The page opens its popup on the person's own gesture and then asks for the authorization over its session socket.
//! The callback mode follows the Origin the socket is bound to: the loopback and Local-domain origins return through
//! Admin's own OAuth start route, and a learned HTTPS origin completes out of band with a code the person pastes back.
//! Each handoff is bound to the socket's Supervisor session.

use super::{
    assistants::{self, Start},
    handoff::HandoffError,
};
use crate::{
    chat::payloads,
    fault::{Fault, Outcome, Reply},
    http::body,
    json::{self, Value},
    process::app::App,
    team::transport::Team,
};

/// The loopback origin.
pub const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:7777";
/// The Local-domain origin.
pub const LOCAL_DOMAIN_ORIGIN: &str = "https://local.shimpz.com";
/// The OAuth start route.
pub const OAUTH_START_PATH: &str = "/api/oauth/cloudflare/start";

/// The callback mode Admin's own page at `origin` completes an authorization with.
///
/// # Errors
///
/// Returns 403 for an origin no longer admitted, and 409 for an admitted one OAuth cannot return to.
pub fn callback_mode(app: &App, origin: &str) -> Result<&'static str, Fault> {
    let admitted = app.allowed_origins().map_err(|_| Fault::Internal)?;
    if !admitted.iter().any(|known| known == origin) {
        return Err(Fault::detail(
            403,
            "OAuth authorization origin is not admitted",
        ));
    }
    if origin == LOOPBACK_ORIGIN {
        return Ok("loopback");
    }
    if origin == LOCAL_DOMAIN_ORIGIN {
        return Ok("local-domain");
    }
    let learned = app.store.browser_origin().map_err(|_| Fault::Internal)?;
    if origin.starts_with("https://") && learned.as_deref() == Some(origin) {
        return Ok("out-of-band");
    }
    Err(Fault::detail(
        409,
        "OAuth authorization is unavailable for this Admin address",
    ))
}

fn handoff_refused(error: HandoffError) -> Fault {
    Fault::detail(409, error.0)
}

fn bad_request(fault: Fault) -> Fault {
    fault.bad_request()
}

fn started(mode: &str, token: &str, url: &str) -> Reply {
    if mode == "out-of-band" {
        return Reply::ok(json::object(vec![
            ("authorization_url", json::text(url)),
            ("completion_mode", json::text("code")),
        ]));
    }
    let origin = if mode == "loopback" {
        LOOPBACK_ORIGIN
    } else {
        LOCAL_DOMAIN_ORIGIN
    };
    Reply::ok(json::object(vec![
        (
            "authorization_url",
            json::text(format!("{origin}{OAUTH_START_PATH}?handoff={token}")),
        ),
        ("completion_mode", json::text("automatic")),
    ]))
}

/// What one authorization asks: the challenge, the page's body, its session, and its Origin.
pub struct Authorize<'a> {
    /// The Team.
    pub team_id: &'a str,
    /// The challenge.
    pub challenge_id: &'a str,
    /// The page's body: exactly the Assistant and the Integration.
    pub payload: &'a Value,
    /// The session cookie.
    pub session: &'a str,
    /// The socket's bound Origin.
    pub origin: &'a str,
}

/// Starts one challenge's authorization with Team and publishes its handoff only after Team answered with a URL.
///
/// # Errors
///
/// Returns 400 for a refused request, 403 or 409 for the callback mode, or 409 for a handoff refusal.
pub async fn authorize(app: &App, team: &Team, request: &Authorize<'_>) -> Outcome {
    body::exact_fields(request.payload, &["assistant_id", "integration_id"])?;
    let mode = callback_mode(app, request.origin)?;
    let team_id = payloads::team_id(&json::text(request.team_id)).map_err(bad_request)?;
    let challenge_id =
        payloads::challenge_id(&json::text(request.challenge_id)).map_err(bad_request)?;
    let handoffs = &app.domains.integrations.handoffs;
    let preparation = handoffs
        .issue(&team_id, &challenge_id, request.session, mode)
        .map_err(handoff_refused)?;
    let start = Start {
        team_id: &team_id,
        challenge_id: &challenge_id,
        assistant_id: request.payload.get("assistant_id").unwrap_or(&Value::Null),
        integration_id: request
            .payload
            .get("integration_id")
            .unwrap_or(&Value::Null),
        session_binding: &preparation.session_binding,
        callback_mode: mode,
    };
    let outcome = async {
        let result = assistants::start_authorization(team, &start)
            .await
            .map_err(bad_request)?;
        if result.status != 200 {
            return Ok(Err(result));
        }
        let url = result
            .get_str("authorization_url")
            .unwrap_or_default()
            .to_owned();
        handoffs
            .authorize(&preparation.token, &url)
            .map_err(handoff_refused)?;
        Ok(Ok(url))
    }
    .await;
    match outcome {
        Ok(Ok(url)) => Ok(started(mode, &preparation.token, &url)),
        Ok(Err(result)) => {
            handoffs.discard(&preparation.token);
            Ok(result)
        }
        Err(fault) => {
            handoffs.discard(&preparation.token);
            Err(fault)
        }
    }
}

/// Finishes an out-of-band authorization with the completion code the person pasted back.
///
/// # Errors
///
/// Returns 400 for a refused request or 409 for a handoff refusal.
pub async fn complete(
    app: &App,
    team: &Team,
    team_id: &str,
    challenge_id: &str,
    payload: &Value,
    session: &str,
) -> Outcome {
    body::exact_fields(payload, &["completion_code"])?;
    let team_id = payloads::team_id(&json::text(team_id)).map_err(bad_request)?;
    let challenge_id = payloads::challenge_id(&json::text(challenge_id)).map_err(bad_request)?;
    let code = json::get_str(payload, "completion_code")
        .ok_or(HandoffError("OAuth completion code is invalid"))
        .map_err(handoff_refused)?;
    let completion = app
        .domains
        .integrations
        .handoffs
        .complete(&team_id, &challenge_id, session, code)
        .map_err(handoff_refused)?;
    assistants::complete_callback(
        team,
        &app.topics,
        &completion.state,
        &completion.claim,
        &completion.session_binding,
    )
    .await
    .map_err(bad_request)
}

/// Cancels the session's pending authorization of one challenge; nothing pending is already cancelled (204).
///
/// # Errors
///
/// Returns 400 for a refused request or 409 for a handoff refusal.
pub async fn cancel(
    app: &App,
    team: &Team,
    team_id: &str,
    challenge_id: &str,
    session: &str,
) -> Outcome {
    let team_id = payloads::team_id(&json::text(team_id)).map_err(bad_request)?;
    let challenge_id = payloads::challenge_id(&json::text(challenge_id)).map_err(bad_request)?;
    let binding = app
        .domains
        .integrations
        .handoffs
        .cancel(&team_id, &challenge_id, session)
        .map_err(handoff_refused)?;
    let Some(binding) = binding else {
        return Ok(Reply::new(204, json::empty()));
    };
    let result = assistants::cancel_authorization(team, &team_id, &challenge_id, &binding)
        .await
        .map_err(bad_request)?;
    Ok(if result.status == 204 {
        Reply::new(204, json::empty())
    } else {
        result
    })
}
