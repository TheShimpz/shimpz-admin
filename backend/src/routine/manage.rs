//! A Local Supervisor's Routine management through Team (ADR-0086).
//!
//! Each call runs under the Supervisor's session assertion. Admin admits Team's answer only in its canonical protocol
//! view; any other body becomes one safe error, so the browser never renders an unchecked Routine.

use std::sync::LazyLock;

use team_protocol::{
    python::regex::{Pattern, declared},
    routine as routine_contract, routine_notice, routine_proposal, routine_run,
};

use crate::{
    chat::payloads,
    fault::{Fault, Reply},
    json::{self, Value},
    team::{
        bridge::is_trace_id,
        transport::{Options, Team},
    },
};

/// A path count in its one canonical decimal form, as Team reads it.
static COUNT_RE: LazyLock<Pattern> = LazyLock::new(|| declared(r"(?:0|[1-9][0-9]{0,9})\Z"));

/// The answer that stands for an invalid Team body.
#[must_use]
pub fn invalid() -> Reply {
    Reply::new(502, json::code("routine-response-invalid"))
}

/// One canonical Routine, run, or proposal id.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for any other value.
pub fn canonical_id(value: &str, name: &str) -> Result<String, Fault> {
    if routine_contract::ROUTINE_ID_RE.is_full(value) {
        Ok(value.to_owned())
    } else {
        Err(Fault::team_request(format!("{name} is invalid")))
    }
}

fn count(value: &str, name: &str, admitted: impl Fn(i64) -> bool) -> Result<i64, Fault> {
    value
        .parse::<i64>()
        .ok()
        .filter(|number| COUNT_RE.is_full(value) && admitted(*number))
        .ok_or_else(|| Fault::team_request(format!("{name} is invalid")))
}

fn offset(value: &str) -> Result<i64, Fault> {
    count(value, "Routine step offset", |start| {
        (0..routine_contract::MAX_ROUTINE_STEPS).contains(&start)
    })
}

/// Team's answer in its closed view, or an error that carries only a safe code.
#[must_use]
pub fn projected(response: &Reply, admit: impl Fn(&Value) -> Option<Value>) -> Reply {
    let body = if json::members(&response.body).is_some() {
        response.body.clone()
    } else {
        json::empty()
    };
    if !response.success() {
        let code = body
            .get("code")
            .filter(|code| routine_contract::matches(code, &routine_contract::ERROR_CODE_RE));
        let status = if (400..=599).contains(&response.status) {
            response.status
        } else {
            502
        };
        return Reply::new(
            status,
            json::object(vec![(
                "code",
                code.cloned()
                    .unwrap_or_else(|| json::text("routine-request-failed")),
            )]),
        );
    }
    if !body.get("trace_id").is_some_and(is_trace_id) {
        return invalid();
    }
    admit(&json::without(&body, "trace_id"))
        .map_or_else(invalid, |admitted| Reply::new(response.status, admitted))
}

/// One field and the check its value passes.
type Check<'a> = (&'a str, &'a dyn Fn(&Value) -> bool);

/// A body admitted only when it holds exactly these fields, each passing its check.
fn exact(body: &Value, fields: &[Check<'_>]) -> Option<Value> {
    let names: Vec<&str> = fields.iter().map(|(name, _)| *name).collect();
    (json::has_exactly(body, &names)
        && fields
            .iter()
            .all(|(name, check)| body.get(name).is_some_and(check)))
    .then(|| body.clone())
}

/// A view admitted only when it names exactly the identities it was asked for.
fn bound(admitted: Option<&Value>, expected: &[(&str, Value)]) -> Option<Value> {
    let admitted = admitted?;
    expected
        .iter()
        .all(|(name, value)| {
            admitted
                .get(name)
                .is_some_and(|found| json::equal(found, value))
        })
        .then(|| admitted.clone())
}

fn team_path(team_id: &str) -> Result<String, Fault> {
    Ok(format!(
        "/v1/teams/{}/routines",
        payloads::team_id(&json::text(team_id))?
    ))
}

fn items(value: &Value, admit: fn(&Value) -> Option<&Value>, maximum: usize) -> bool {
    json::as_array(value).is_some_and(|items| {
        items.len() <= maximum && items.iter().all(|item| admit(item).is_some())
    })
}

/// The Team's Routines, their runs, and its held runs' incidents.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn list_routines(team: &Team, team_id: &str) -> Result<Reply, Fault> {
    let canonical = payloads::team_id(&json::text(team_id))?;
    let options = Options {
        response_limit: routine_notice::MAX_ROUTINE_LIST_BYTES,
        ..Options::default()
    };
    let response = team
        .call_with("GET", &team_path(&canonical)?, None, options)
        .await?;
    let id = json::text(&canonical);
    Ok(projected(&response, |body| {
        exact(
            body,
            &[
                ("team_id", &|value| json::equal(value, &id)),
                ("routines", &|value| {
                    items(
                        value,
                        routine_notice::canonical_routine_view,
                        routine_contract::MAX_ROUTINES,
                    )
                }),
                ("runs", &|value| {
                    items(
                        value,
                        routine_notice::canonical_run_view,
                        routine_contract::MAX_ROUTINES,
                    )
                }),
                ("incidents", &|value| {
                    items(
                        value,
                        routine_notice::canonical_incident_view,
                        routine_notice::MAX_UNRESOLVED_INCIDENTS,
                    )
                }),
            ],
        )
    }))
}

/// The one exact operation a Supervisor confirms before Admin asks Team to delete this Routine (ADR-0051).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub fn deletion_subject(team_id: &str, routine_id: &str) -> Result<String, Fault> {
    let canonical = payloads::team_id(&json::text(team_id))?;
    Ok(format!(
        "routine-delete:{canonical}:{}",
        canonical_id(routine_id, "Routine")?
    ))
}

/// Deletes one Routine.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn delete(team: &Team, team_id: &str, routine_id: &str) -> Result<Reply, Fault> {
    let base = team_path(team_id)?;
    let routine = canonical_id(routine_id, "Routine")?;
    let response = team
        .call("DELETE", &format!("{base}/{routine}"), None)
        .await?;
    let (id, routine) = (
        json::text(payloads::team_id(&json::text(team_id))?),
        json::text(routine),
    );
    Ok(projected(&response, |body| {
        exact(
            body,
            &[
                ("team_id", &|value| json::equal(value, &id)),
                ("routine_id", &|value| json::equal(value, &routine)),
                ("deleted", &|value| matches!(value, Value::Bool(_))),
            ],
        )
    }))
}

/// The canonical Team id and run id of a run call.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub fn run_ids(team_id: &str, run_id: &str) -> Result<(String, String), Fault> {
    Ok((
        payloads::team_id(&json::text(team_id))?,
        canonical_id(run_id, "Routine run")?,
    ))
}

fn identities(team_id: &str, name: &str, id: &str) -> Vec<(&'static str, Value)> {
    let name: &'static str = if name == "run_id" {
        "run_id"
    } else {
        "proposal_id"
    };
    vec![("team_id", json::text(team_id)), (name, json::text(id))]
}

/// Opens a held run's recovery card for the authenticated person (ADR-0092 section 7).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn open_card(team: &Team, team_id: &str, run_id: &str) -> Result<Reply, Fault> {
    let (canonical, run) = run_ids(team_id, run_id)?;
    let path = format!("/v1/teams/{canonical}/routines/incidents/{run}/card");
    let response = team.call("POST", &path, Some(&json::empty())).await?;
    let expected = identities(&canonical, "run_id", &run);
    Ok(projected(&response, |body| {
        bound(routine_run::canonical_card(body), &expected)
    }))
}

/// Answers one open recovery card once with its tag alone; it runs no model, so it carries no model credential.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id or answer.
pub async fn answer_card(
    team: &Team,
    team_id: &str,
    run_id: &str,
    body: &Value,
) -> Result<Reply, Fault> {
    let (canonical, run) = run_ids(team_id, run_id)?;
    let answer = routine_run::canonical_card_answer_request(body)
        .ok_or_else(|| Fault::team_request("Routine card answer is invalid"))?;
    let path = format!("/v1/teams/{canonical}/routines/incidents/{run}/answer");
    let response = team.call("POST", &path, Some(&answer)).await?;
    let expected = identities(&canonical, "run_id", &run);
    Ok(projected(&response, |body| {
        bound(routine_run::canonical_card_answer(body), &expected)
    }))
}

async fn proposal(
    team: &Team,
    team_id: &str,
    proposal_id: &str,
    confirm: bool,
    statuses: &[&str],
) -> Result<Reply, Fault> {
    let canonical = payloads::team_id(&json::text(team_id))?;
    let proposal = canonical_id(proposal_id, "Routine proposal")?;
    let path = format!("/v1/teams/{canonical}/routines/proposals/{proposal}");
    // Confirm sends an empty object; revoke, like a deletion, sends no body.
    let response = if confirm {
        team.call("POST", &path, Some(&json::empty())).await?
    } else {
        team.call("DELETE", &path, None).await?
    };
    let expected = identities(&canonical, "proposal_id", &proposal);
    Ok(projected(&response, |body| {
        bound(routine_proposal::canonical_proposal_answer(body), &expected).filter(|admitted| {
            json::get_str(admitted, "status").is_some_and(|status| statuses.contains(&status))
        })
    }))
}

/// Confirms a card: the person's one tap that creates or changes the Routine it shows (ADR-0101).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn confirm_proposal(
    team: &Team,
    team_id: &str,
    proposal_id: &str,
) -> Result<Reply, Fault> {
    proposal(team, team_id, proposal_id, true, &["created", "changed"]).await
}

/// Revokes the card, so nothing it shows can ever be created; a card already confirmed answers with its Routine.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn revoke_proposal(
    team: &Team,
    team_id: &str,
    proposal_id: &str,
) -> Result<Reply, Fault> {
    proposal(
        team,
        team_id,
        proposal_id,
        false,
        &["revoked", "created", "changed"],
    )
    .await
}

/// One run's execution details (ADR-0092): Team's sanitized diagnostics.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn diagnostics(team: &Team, team_id: &str, run_id: &str) -> Result<Reply, Fault> {
    let (canonical, run) = run_ids(team_id, run_id)?;
    let path = format!("/v1/teams/{canonical}/routines/runs/{run}/diagnostics");
    let response = team.call("GET", &path, None).await?;
    let expected = identities(&canonical, "run_id", &run);
    Ok(projected(&response, |body| {
        bound(routine_run::canonical_diagnostics(body), &expected)
    }))
}

/// One page of a Routine revision's steps from `offset`, admitted only for exactly the page asked for.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id, revision, or offset.
pub async fn plan_steps(
    team: &Team,
    team_id: &str,
    routine_id: &str,
    revision: &str,
    offset_text: &str,
) -> Result<Reply, Fault> {
    let base = team_path(team_id)?;
    let routine = canonical_id(routine_id, "Routine")?;
    let number = count(revision, "Routine revision", |number| {
        routine_contract::valid_revision(&json::int(number))
    })?;
    let start = offset(offset_text)?;
    let path = format!("{base}/{routine}/revisions/{number}/steps/{start}");
    let response = team.call("GET", &path, None).await?;
    let expected = [
        ("routine_id", json::text(&routine)),
        ("revision", json::int(number)),
        ("offset", json::int(start)),
    ];
    Ok(projected(&response, |body| {
        bound(routine_contract::canonical_page(body), &expected)
    }))
}

/// One page of what a run did step by step, from `offset`, of one snapshot of its records (`latest` for the current).
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id, snapshot, or offset.
pub async fn run_steps(
    team: &Team,
    team_id: &str,
    run_id: &str,
    snapshot: &str,
    offset_text: &str,
) -> Result<Reply, Fault> {
    let (canonical, run) = run_ids(team_id, run_id)?;
    if snapshot != "latest" && !routine_run::SNAPSHOT_RE.is_full(snapshot) {
        return Err(Fault::team_request("Routine run snapshot is invalid"));
    }
    let start = offset(offset_text)?;
    let path = format!("/v1/teams/{canonical}/routines/runs/{run}/steps/{snapshot}/{start}");
    let response = team.call("GET", &path, None).await?;
    let mut expected = identities(&canonical, "run_id", &run);
    expected.push(("offset", json::int(start)));
    Ok(projected(&response, |body| {
        bound(routine_run::canonical_run_steps(body), &expected).filter(|page| {
            snapshot == "latest" || json::get_str(page, "snapshot") == Some(snapshot)
        })
    }))
}

/// Turns a Routine's dispatch off (`paused`) or back on.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn set_paused(
    team: &Team,
    team_id: &str,
    routine_id: &str,
    paused: bool,
) -> Result<Reply, Fault> {
    let canonical = payloads::team_id(&json::text(team_id))?;
    let routine = canonical_id(routine_id, "Routine")?;
    let action = if paused { "pause" } else { "resume" };
    let path = format!("/v1/teams/{canonical}/routines/{routine}/{action}");
    let response = team.call("POST", &path, Some(&json::empty())).await?;
    let (id, routine) = (json::text(canonical), json::text(routine));
    Ok(projected(&response, |body| {
        exact(
            body,
            &[
                ("team_id", &|value| json::equal(value, &id)),
                ("routine_id", &|value| json::equal(value, &routine)),
                ("paused", &|value| *value == Value::Bool(paused)),
            ],
        )
    }))
}

#[cfg(test)]
mod tests;
