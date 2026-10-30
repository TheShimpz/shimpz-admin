//! A Team's Routines over the session socket (ADR-0114 tranche (c), ADR-0086).
//!
//! Each method is the backend function its route ran, on a lane worker that checks the socket's Origin and session
//! again when its turn comes. Every Routine change Admin completes raises the Team's `routines` topic. A frozen run that
//! resumes after a human answer or a connected Integration is a long call on its own lane: it says once that it
//! started and answers when Team does. A human answer is authenticated by chat's own Action-password authority, so
//! both share one lockout. Deleting a Routine is a confirmed operation bound to that exact Routine.

use std::sync::Arc;

use super::{answer, history, manage};
use crate::{
    app::App,
    fault::{Fault, Outcome, Reply},
    session::{
        calls::{self, Call, Run},
        stepup,
    },
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

/// As Team answers a Routine change: the sockets showing the Team's Routines read them again, and a 200 answer that
/// made a Routine due now wakes the scheduler.
fn settled(app: &App, team_id: &str, response: Reply, wake: bool) -> Reply {
    if response.success() {
        app.topics.team_changed(team_id, &["routines"]);
    }
    if wake && response.status == 200 {
        app.domains.routines.scheduler.wake(app.clock.now_ms());
    }
    response
}

/// `routines.list`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_list(call: &Call) -> Outcome {
    let team_id = text(call, "team_id");
    on_lane!(call, |_app, team| manage::list_routines(&team, &team_id)
        .await
        .map_err(Fault::bad_request))
}

/// `routines.diagnostics`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_diagnostics(call: &Call) -> Outcome {
    let (team_id, run_id) = (text(call, "team_id"), text(call, "run_id"));
    on_lane!(call, |_app, team| manage::diagnostics(
        &team, &team_id, &run_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `routines.run_steps`.
///
/// # Errors
///
/// Returns 400 for an invalid id, snapshot, or offset.
pub async fn routines_run_steps(call: &Call) -> Outcome {
    let (team_id, run_id) = (text(call, "team_id"), text(call, "run_id"));
    let (snapshot, offset) = (text(call, "snapshot"), text(call, "offset"));
    on_lane!(call, |_app, team| manage::run_steps(
        &team, &team_id, &run_id, &snapshot, &offset
    )
    .await
    .map_err(Fault::bad_request))
}

/// `routines.plan_steps`.
///
/// # Errors
///
/// Returns 400 for an invalid id, revision, or offset.
pub async fn routines_plan_steps(call: &Call) -> Outcome {
    let (team_id, routine_id) = (text(call, "team_id"), text(call, "routine_id"));
    let (revision, offset) = (text(call, "revision"), text(call, "offset"));
    on_lane!(call, |_app, team| manage::plan_steps(
        &team,
        &team_id,
        &routine_id,
        &revision,
        &offset
    )
    .await
    .map_err(Fault::bad_request))
}

async fn set_paused(call: &Call, paused: bool) -> Outcome {
    let (team_id, routine_id) = (text(call, "team_id"), text(call, "routine_id"));
    on_lane!(call, |app, team| {
        let response = manage::set_paused(&team, &team_id, &routine_id, paused)
            .await
            .map_err(Fault::bad_request)?;
        Ok(settled(&app, &team_id, response, false))
    })
}

/// `routines.pause`: turns a Routine's dispatch off until it is resumed; a run already going finishes.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_pause(call: &Call) -> Outcome {
    set_paused(call, true).await
}

/// `routines.resume`: turns a paused Routine's dispatch back on; an unresolved incident still holds it.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_resume(call: &Call) -> Outcome {
    set_paused(call, false).await
}

/// `routines.card`: opening a recovery card only reads the held run's state.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_card(call: &Call) -> Outcome {
    let (team_id, run_id) = (text(call, "team_id"), text(call, "run_id"));
    on_lane!(call, |_app, team| manage::open_card(
        &team, &team_id, &run_id
    )
    .await
    .map_err(Fault::bad_request))
}

/// `routines.card_answer`: Rodar makes the Routine due again.
///
/// # Errors
///
/// Returns 400 for an invalid id or answer.
pub async fn routines_card_answer(call: &Call) -> Outcome {
    let (team_id, run_id, body) = (
        text(call, "team_id"),
        text(call, "run_id"),
        call.body().clone(),
    );
    on_lane!(call, |app, team| {
        let response = manage::answer_card(&team, &team_id, &run_id, &body)
            .await
            .map_err(Fault::bad_request)?;
        Ok(settled(&app, &team_id, response, true))
    })
}

/// `routines.challenge`: opening a frozen run's challenge mints a fresh one but changes nothing the list shows.
///
/// # Errors
///
/// Returns 400 for an invalid id or opening.
pub async fn routines_challenge(call: &Call) -> Outcome {
    let (team_id, run_id, body) = (
        text(call, "team_id"),
        text(call, "run_id"),
        call.body().clone(),
    );
    on_lane!(call, |app, team| app
        .domains
        .routines
        .challenges
        .open_challenge(&team, &team_id, &run_id, &body)
        .await
        .map_err(Fault::bad_request))
}

async fn proposal(call: &Call, confirm: bool) -> Outcome {
    let (team_id, proposal_id) = (text(call, "team_id"), text(call, "proposal_id"));
    on_lane!(call, |app, team| {
        let response = if confirm {
            manage::confirm_proposal(&team, &team_id, &proposal_id).await
        } else {
            manage::revoke_proposal(&team, &team_id, &proposal_id).await
        }
        .map_err(Fault::bad_request)?;
        if response.status == 200 {
            // Kept in the Team's transcript as soon as Team gives it, so a reload shows it answered.
            let _ = history::append_proposal_answer(&app, &response.body);
        }
        Ok(settled(&app, &team_id, response, confirm))
    })
}

/// `routines.proposal_confirm`: a created Routine is due soon.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_proposal_confirm(call: &Call) -> Outcome {
    proposal(call, true).await
}

/// `routines.proposal_revoke`.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_proposal_revoke(call: &Call) -> Outcome {
    proposal(call, false).await
}

fn deletion_subject(call: &Call) -> Result<String, Reply> {
    manage::deletion_subject(call.text("team_id"), call.text("routine_id"))
        .map_err(|_| Reply::detail(400, "Routine is invalid"))
}

/// `routines.deletion`: the password, then one second factor bound to this exact Routine (ADR-0051).
///
/// # Errors
///
/// Returns the confirmation's refusal.
pub async fn routines_deletion(call: &Call) -> Outcome {
    match deletion_subject(call) {
        Ok(subject) => stepup::begin(call, subject).await,
        Err(refused) => Ok(refused),
    }
}

/// `routines.delete`: Team is asked to delete the Routine only once the second factor confirmed this exact one.
///
/// # Errors
///
/// Returns the confirmation's refusal or the Team request's fault.
pub async fn routines_delete(call: &Call) -> Outcome {
    let subject = match deletion_subject(call) {
        Ok(subject) => subject,
        Err(refused) => return Ok(refused),
    };
    let app = Arc::clone(call.app());
    let team = call.team()?;
    let (team_id, routine_id) = (text(call, "team_id"), text(call, "routine_id"));
    stepup::complete(call, subject, move |_asker| async move {
        let response = manage::delete(&team, &team_id, &routine_id)
            .await
            .map_err(Fault::bad_request)?;
        Ok(settled(&app, &team_id, response, false))
    })
    .await
}

fn resume_lane(call: &Call, announce: bool) -> Run<'_> {
    Run {
        lane: &call.app().domains.session.lanes.resume,
        full: calls::full(),
        announce,
    }
}

/// `routines.human`: answers a frozen run's open challenge with chat's exact human-response frame; the run then
/// resumes or ends. The page hears that it started only once the answer is authenticated and the socket still current.
///
/// # Errors
///
/// Returns 400 for an answer outside the protocol, or the Team request's fault.
pub async fn routines_human(call: &Call) -> Outcome {
    let app = Arc::clone(call.app());
    let team = call.team()?;
    let socket = Arc::clone(&call.socket);
    let (id, team_id, run_id, frame) = (
        call.id.clone(),
        text(call, "team_id"),
        text(call, "run_id"),
        call.body().clone(),
    );
    call.run(resume_lane(call, false), async move {
        let checked = app
            .domains
            .routines
            .challenges
            .authenticated(&app.action_passwords, &team_id, &run_id, &frame)
            .await
            .map_err(|_| Fault::detail(400, "human response is invalid"))?;
        let answered = match checked {
            Ok(answered) => answered,
            Err(refusal) => return Ok(refusal),
        };
        if !calls::current(&socket).await {
            return Err(Fault::Closed);
        }
        socket.progress(&id);
        let resumed = answer::resume_answered(&team, &answered).await?;
        let resumed = settled(&app, &team_id, resumed, false);
        Ok(answer::answered_outcome(&answered, resumed))
    })
    .await
}

/// `routines.integrations`: after the Integration is connected, the frozen run continues from where it froze.
///
/// # Errors
///
/// Returns 400 for an invalid id.
pub async fn routines_integrations(call: &Call) -> Outcome {
    let app = Arc::clone(call.app());
    let team = call.team()?;
    let (team_id, run_id) = (text(call, "team_id"), text(call, "run_id"));
    call.run(resume_lane(call, true), async move {
        let response = answer::resume_integrations(&team, &team_id, &run_id)
            .await
            .map_err(Fault::bad_request)?;
        Ok(settled(&app, &team_id, response, false))
    })
    .await
}
