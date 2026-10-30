//! The Team methods of the session socket. Each answers as its HTTP route did: a request Admin refused before Team
//! is the page's own 400, Team's answer passes as Team gave it, and every Team call runs on a lane worker that checks
//! the socket's Origin and session again when its turn comes.

use std::sync::Arc;

use super::{bridge, names, order, sign_ins, stored_input, summary};
use crate::{
    fault::{Fault, Outcome, Reply},
    json::{self, Value},
    session::{
        calls::{self, Call, Run},
        stepup,
    },
    signin::local::{self, Factor},
};

/// Runs `$body` on the call lane with the process as `$app` and Team under the call's authority as `$team`.
macro_rules! on_lane {
    ($call:expr, |$app:ident, $team:ident| $body:expr) => {{
        let $app = Arc::clone($call.app());
        let $team = $call.team()?;
        $call.on_lane(async move { $body }).await
    }};
}

fn text(call: &Call, name: &str) -> String {
    call.text(name).to_owned()
}

/// `teams.list`.
///
/// # Errors
///
/// Returns the lane's or authority's fault.
pub async fn teams_list(call: &Call) -> Outcome {
    on_lane!(call, |app, team| order::listing(&app, &team).await)
}

/// `teams.create`.
///
/// # Errors
///
/// Returns 400 for an invalid name, or the Team request's fault.
pub async fn teams_create(call: &Call) -> Outcome {
    let payload = call.body().clone();
    on_lane!(call, |app, team| names::create(&app, &team, &payload).await)
}

/// `teams.rename`.
///
/// # Errors
///
/// Returns 400 for an invalid name or id.
pub async fn teams_rename(call: &Call) -> Outcome {
    let (team_id, payload) = (text(call, "team_id"), call.body().clone());
    on_lane!(call, |app, team| names::rename(
        &app, &team, &team_id, &payload
    )
    .await)
}

/// `teams.reorder`: saves the Team list order the Supervisor arranged; a saved order changes the `teams` topic.
///
/// # Errors
///
/// Returns 400 for an invalid body.
pub async fn teams_reorder(call: &Call) -> Outcome {
    let payload = call.body().clone();
    on_lane!(call, |app, team| {
        let team_ids = order::requested_ids(&payload)?;
        let response = {
            let _order = app.domains.team.order.lock().await;
            order::reorder(&team, &app.config.team_order_path, &team_ids).await
        };
        if response.success() {
            app.topics.changed("teams");
        }
        Ok(response)
    })
}

/// `teams.delete`: the exact current name and the Supervisor password confirm it, within sign-in's own limits.
///
/// # Errors
///
/// Returns 400 for an invalid body, sign-in's refusal, or the Team request's fault.
pub async fn teams_delete(call: &Call) -> Outcome {
    let (team_name, password) = names::deletion(call.body())?;
    local::recheck_password(call.app(), Some(call.socket.origin()), &password).await?;
    let team_id = text(call, "team_id");
    let deleted = team_id.clone();
    let response = on_lane!(call, |app, team| {
        names::delete(&app, &team, &deleted, &team_name).await
    })?;
    if response.success() {
        // The deleted Team's chat run ends with it, whoever watched it (ADR-0119).
        super::history::end_runs(call.app(), Some(&team_id));
    }
    Ok(response)
}

/// `inference.read`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn inference_read(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| bridge::get_inference(&team, &team_id)
        .await
        .map_err(Fault::bad_request))
}

/// `inference.save`.
///
/// # Errors
///
/// Returns 400 for an invalid id or selection.
pub async fn inference_save(call: &Call) -> Outcome {
    let (team_id, payload) = (text(call, "team_id"), call.body().clone());
    on_lane!(call, |app, team| bridge::configure_inference(
        &team,
        &app.topics,
        &team_id,
        &payload
    )
    .await
    .map_err(Fault::bad_request))
}

/// `assistants.registry`.
///
/// # Errors
///
/// Returns 502 for an invalid registry.
pub async fn assistants_registry(call: &Call) -> Outcome {
    on_lane!(call, |_app, team| summary::assistants_list(&team).await)
}

/// `assistants.list`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn assistants_list(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| bridge::list_installed_assistants(
        &team, &team_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// An install runs on its own lane; once it starts, the page hears so, and its result follows when Team answers.
async fn install(call: &Call, local_image: bool) -> Outcome {
    let app = Arc::clone(call.app());
    let team = call.team()?;
    let (team_id, payload) = (text(call, "team_id"), call.body().clone());
    let run = Run {
        lane: &call.app().domains.session.lanes.install,
        full: calls::full(),
        announce: true,
    };
    call.run(run, async move {
        let installed = if local_image {
            bridge::install_local_assistant(&team, &app.topics, &team_id, &payload).await
        } else {
            bridge::install_assistant(&team, &app.topics, &team_id, &payload).await
        };
        installed.map_err(Fault::bad_request)
    })
    .await
}

/// `assistants.install`.
///
/// # Errors
///
/// Returns 400 for an invalid id or selection.
pub async fn assistants_install(call: &Call) -> Outcome {
    install(call, false).await
}

/// `assistants.install_local`.
///
/// # Errors
///
/// Returns 400 for an invalid id or image.
pub async fn assistants_install_local(call: &Call) -> Outcome {
    install(call, true).await
}

/// `assistants.uninstall`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn assistants_uninstall(call: &Call) -> Outcome {
    let (team_id, assistant_id) = (text(call, "team_id"), text(call, "assistant_id"));
    on_lane!(call, |app, team| bridge::uninstall_assistant(
        &team,
        &app.topics,
        &team_id,
        &assistant_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `assistants.summary`.
///
/// # Errors
///
/// Returns 422, 400, or 502 as the summary is refused.
pub async fn assistants_summary(call: &Call) -> Outcome {
    let (team_id, assistant_id, locale) = (
        text(call, "team_id"),
        text(call, "assistant_id"),
        text(call, "locale"),
    );
    on_lane!(call, |_app, team| summary::assistant_summary(
        &team,
        &team_id,
        &assistant_id,
        &locale
    )
    .await)
}

/// `assistants.details`.
///
/// # Errors
///
/// Returns 422, 400, or 502 as the page is refused.
pub async fn assistants_details(call: &Call) -> Outcome {
    let (team_id, assistant_id, locale) = (
        text(call, "team_id"),
        text(call, "assistant_id"),
        text(call, "locale"),
    );
    on_lane!(call, |_app, team| summary::assistant_details(
        &team,
        &team_id,
        &assistant_id,
        &locale
    )
    .await)
}

/// `snapshots.list`.
///
/// # Errors
///
/// Returns the lane's or authority's fault.
pub async fn snapshots_list(call: &Call) -> Outcome {
    on_lane!(call, |_app, team| summary::local_assistants_list(&team)
        .await)
}

/// `snapshots.summary`.
///
/// # Errors
///
/// Returns 422, 400, or 502 as the summary is refused.
pub async fn snapshots_summary(call: &Call) -> Outcome {
    let (image_id, locale) = (text(call, "image_id"), text(call, "locale"));
    on_lane!(call, |_app, team| summary::local_assistant_summary(
        &team, &image_id, &locale
    )
    .await)
}

/// `snapshots.details`.
///
/// # Errors
///
/// Returns 422, 400, or 502 as the page is refused.
pub async fn snapshots_details(call: &Call) -> Outcome {
    let (image_id, locale) = (text(call, "image_id"), text(call, "locale"));
    on_lane!(call, |_app, team| summary::local_assistant_details(
        &team, &image_id, &locale
    )
    .await)
}

/// `stored_inputs.list`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn stored_inputs_list(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| stored_input::list(&team, &team_id)
        .await
        .map_err(Fault::bad_request))
}

/// `stored_inputs.clear`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn stored_inputs_clear(call: &Call) -> Outcome {
    let (team_id, assistant_id, stored_input_id) = (
        text(call, "team_id"),
        text(call, "assistant_id"),
        text(call, "stored_input_id"),
    );
    on_lane!(call, |app, team| stored_input::clear(
        &team,
        &app.topics,
        &team_id,
        &assistant_id,
        &stored_input_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `files.acknowledge`: the Supervisor accepts the risk of saving one file the Browser downloaded (ADR-0117 §7).
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn files_acknowledge(call: &Call) -> Outcome {
    let (team_id, file_id) = (text(call, "team_id"), text(call, "file_id"));
    on_lane!(call, |_app, team| bridge::acknowledge_file(
        &team, &team_id, &file_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `browser.view`: the view id of the Browser task the Team runs now.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn browser_view(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| bridge::open_browser_view(
        &team, &team_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `sign_in.start`: a sign-in session that belongs to the socket's authority, whose end cancels it (ADR-0117).
///
/// # Errors
///
/// Returns 400 for an inadmissible body or id.
pub async fn sign_in_start(call: &Call) -> Outcome {
    let authority = call.socket.authority();
    call.app().domains.team.sign_ins.sweep(call.app());
    let team_id = text(call, "team_id");
    let body = sign_ins::with_origin(call.body(), call.socket.origin());
    on_lane!(call, |app, team| app
        .domains
        .team
        .sign_ins
        .start_under(&app, &team, authority, &team_id, &body)
        .await
        .map_err(Fault::bad_request))
}

/// Saves or cancels a sign-in session; once it no longer runs, its authority's end has nothing to cancel.
async fn sign_in_finish(call: &Call, save: bool) -> Outcome {
    let team_id = text(call, "team_id");
    let body = sign_ins::with_origin(call.body(), call.socket.origin());
    on_lane!(call, |app, team| {
        let response = if save {
            sign_ins::save(&team, &app.topics, &team_id, &body).await
        } else {
            sign_ins::cancel(&team, &app.topics, &team_id, &body).await
        }
        .map_err(Fault::bad_request)?;
        if response.status == 200 || response.get_str("code") == Some("sign-in-not-running") {
            let session = json::get_str(&body, "sign_in_session_id");
            app.domains.team.sign_ins.finished(&team_id, session);
        }
        Ok(response)
    })
}

/// `sign_in.save`.
///
/// # Errors
///
/// Returns 400 for an inadmissible body or id.
pub async fn sign_in_save(call: &Call) -> Outcome {
    sign_in_finish(call, true).await
}

/// `sign_in.cancel`.
///
/// # Errors
///
/// Returns 400 for an inadmissible body or id.
pub async fn sign_in_cancel(call: &Call) -> Outcome {
    sign_in_finish(call, false).await
}

/// `sign_in.read`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn sign_in_read(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| sign_ins::current(&team, &team_id)
        .await
        .map_err(Fault::bad_request))
}

/// `sign_in.deletion`: reads the Team's Sign-in and begins a confirmation bound to it.
///
/// # Errors
///
/// Returns the read's or confirmation's refusal.
pub async fn sign_in_deletion(call: &Call) -> Outcome {
    let read = sign_in_read(call).await?;
    if read.status != 200 {
        return Ok(read);
    }
    let sign_in = read.get("sign_in").cloned().unwrap_or(Value::Null);
    if sign_in == Value::Null {
        return Ok(Reply::new(
            404,
            json::detail_code("sign-in unavailable", "sign-in-absent"),
        ));
    }
    let subject = sign_ins::deletion_subject(call.text("team_id"), &sign_in)?;
    stepup::begin(call, subject).await
}

fn refused_as_request(fault: Fault) -> Outcome {
    match fault {
        Fault::TeamRequest(reason) => Ok(Reply::detail(400, &reason)),
        Fault::Refused(refusal) => Ok(Reply::new(400, refusal.body)),
        other => Err(other),
    }
}

/// `sign_in.delete`: Team deletes the Sign-in only once the second factor confirmed this exact one.
///
/// # Errors
///
/// Returns the confirmation's refusal or the Team request's fault.
pub async fn sign_in_delete(call: &Call) -> Outcome {
    let prepared = (|| {
        let named = sign_ins::confirmed(
            call.param("sign_in_id"),
            call.param("generation"),
            call.param("team_incarnation"),
        )?;
        let subject = sign_ins::deletion_subject(call.text("team_id"), &named)?;
        let (factor, _) = local::operation_factor(call.body())?;
        Ok::<_, Fault>((named, subject, factor))
    })();
    let (named, subject, factor) = match prepared {
        Ok(prepared) => prepared,
        Err(fault) => return refused_as_request(fault),
    };
    let app = Arc::clone(call.app());
    let team = call.team()?;
    let (team_id, origin) = (text(call, "team_id"), call.socket.origin().to_owned());
    let factor = match factor {
        Factor::Totp => "totp",
        Factor::Passkey => "passkey",
    };
    stepup::complete(call, subject, move |_asker| async move {
        sign_ins::delete(&team, &app.topics, &team_id, &named, factor, &origin)
            .await
            .map_err(Fault::bad_request)
    })
    .await
}
