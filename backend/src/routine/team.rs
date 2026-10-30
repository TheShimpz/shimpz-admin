//! Admin's machine calls to Team for Routines (ADR-0086): claim, run one leased segment, and fetch and acknowledge
//! notices. Claims and notices use only the Team bearer; a run segment is signed by Admin's Routine identity for the
//! run's own lease. Every answer is admitted only in its canonical protocol view.

use std::time::Duration;

use team_protocol::{routine_notice, routine_run};
use zeroize::Zeroizing;

use crate::{
    fault::Reply,
    json::{self, Value},
    supervisor::identity::LocalIdentity,
    team::{
        bridge::is_trace_id,
        transport::{Bindings, MAX_JSON_BODY_BYTES, Options, Team},
    },
};

/// A segment's socket timeout is never below fifteen minutes.
pub const MIN_RUN_TIMEOUT_SECONDS: i64 = 15 * 60;
/// The margin past a run's claimed active time.
pub const RUN_TIMEOUT_MARGIN_SECONDS: i64 = 5 * 60;
/// A person's answer resumes a run whose active time Admin was never told, so it waits as long as any run may spend.
pub const RESUME_TIMEOUT_SECONDS: i64 =
    routine_run::MAX_ACTIVE_SECONDS + RUN_TIMEOUT_MARGIN_SECONDS;

/// Team did not answer a Routine call in its closed form; the caller retries on its next tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoutineTeamError;

/// Team's 200 answer without its required trace identifier.
///
/// # Errors
///
/// Returns [`RoutineTeamError`] for any other answer.
pub fn answer(response: &Reply) -> Result<Value, RoutineTeamError> {
    if response.status != 200 || json::members(&response.body).is_none() {
        return Err(RoutineTeamError);
    }
    if !response.body.get("trace_id").is_some_and(is_trace_id) {
        return Err(RoutineTeamError);
    }
    Ok(json::without(&response.body, "trace_id"))
}

async fn post(team: &Team, path: &str, body: &Value) -> Result<Value, RoutineTeamError> {
    let response = team
        .call("POST", path, Some(body))
        .await
        .map_err(|_| RoutineTeamError)?;
    answer(&response)
}

/// Leases at most one due run: `run` is null when nothing may start now, and `next_due_at` then hints when.
///
/// # Errors
///
/// Returns [`RoutineTeamError`].
pub async fn claim(team: &Team, long: bool) -> Result<Value, RoutineTeamError> {
    let body = post(
        team,
        "/v1/routines/claim",
        &json::object(vec![("long", Value::Bool(long))]),
    )
    .await?;
    routine_run::canonical_claim(&body).ok_or(RoutineTeamError)
}

fn active_seconds(claimed: &Value) -> i64 {
    claimed
        .get("active_seconds")
        .and_then(json::as_int)
        .unwrap_or_default()
}

/// Whether a claimed run may spend more active time than a short one.
#[must_use]
pub fn is_long(claimed: &Value) -> bool {
    active_seconds(claimed) > routine_run::SHORT_ACTIVE_SECONDS
}

/// The socket timeout of one segment of a claimed run.
#[must_use]
pub fn run_timeout(claimed: &Value) -> Duration {
    let seconds = MIN_RUN_TIMEOUT_SECONDS.max(active_seconds(claimed) + RUN_TIMEOUT_MARGIN_SECONDS);
    Duration::from_secs(u64::try_from(seconds).unwrap_or(0))
}

/// Runs one segment of a claimed run under its lease; how the run stands afterwards. A run asks no model.
///
/// # Errors
///
/// Returns [`RoutineTeamError`].
pub async fn run(
    team: &Team,
    claimed: &Value,
    identity: LocalIdentity,
) -> Result<String, RoutineTeamError> {
    let field = |name: &str| json::get_str(claimed, name).unwrap_or_default().to_owned();
    let (team_id, run_id) = (field("team_id"), field("run_id"));
    let body = json::object(vec![
        (
            "revision",
            claimed.get("revision").cloned().unwrap_or(Value::Null),
        ),
        (
            "plan_digest",
            claimed.get("plan_digest").cloned().unwrap_or(Value::Null),
        ),
    ]);
    let options = Options {
        timeout: run_timeout(claimed),
        bindings: Bindings {
            routine: Some((identity, Zeroizing::new(field("lease_token")))),
            ..Bindings::default()
        },
        ..Options::default()
    };
    let response = team
        .call_stream(
            "POST",
            &format!("/v1/teams/{team_id}/routines/runs/{run_id}/segment"),
            &body,
            options,
            &|_| {},
        )
        .await
        .map_err(|_| RoutineTeamError)?;
    let answered = answer(&response)?;
    let segment = routine_run::canonical_segment_answer(&answered).ok_or(RoutineTeamError)?;
    if json::get_str(segment, "team_id") != Some(team_id.as_str())
        || json::get_str(segment, "run_id") != Some(run_id.as_str())
    {
        return Err(RoutineTeamError);
    }
    Ok(json::get_str(segment, "status")
        .unwrap_or_default()
        .to_owned())
}

/// One bounded batch of every Team's undelivered notices.
///
/// # Errors
///
/// Returns [`RoutineTeamError`].
pub async fn notices(team: &Team) -> Result<Value, RoutineTeamError> {
    let response = team
        .call("GET", "/v1/routines/notices", None)
        .await
        .map_err(|_| RoutineTeamError)?;
    routine_notice::canonical_notice_batch(&answer(&response)?).ok_or(RoutineTeamError)
}

/// Splits deliveries so each acknowledgment fits both Team's delivery count and Admin's request body bound.
#[must_use]
pub fn acknowledgments(deliveries: Vec<Value>) -> Vec<Vec<Value>> {
    let empty = json::compact_len(&json::object(vec![(
        "deliveries",
        Value::Array(Vec::new()),
    )]));
    let mut chunks = Vec::new();
    let mut chunk: Vec<Value> = Vec::new();
    let mut size = empty;
    for item in deliveries {
        let cost = json::compact_len(&item);
        if !chunk.is_empty()
            && (chunk.len() == routine_run::MAX_ACK_DELIVERIES
                || size + 1 + cost > MAX_JSON_BODY_BYTES)
        {
            chunks.push(std::mem::take(&mut chunk));
            size = empty;
        }
        size += cost + usize::from(!chunk.is_empty());
        chunk.push(item);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

/// Admin wrote these exact notice versions to their transcripts; acknowledged in bounded requests.
///
/// # Errors
///
/// Returns [`RoutineTeamError`].
pub async fn acknowledge(team: &Team, delivered: &[Value]) -> Result<(), RoutineTeamError> {
    let deliveries = delivered
        .iter()
        .map(|item| {
            let field = |name: &str| item.get(name).cloned().unwrap_or(Value::Null);
            json::object(vec![
                ("team_id", field("team_id")),
                ("notice_id", field("notice_id")),
                ("version", field("version")),
            ])
        })
        .collect();
    for chunk in acknowledgments(deliveries) {
        let body = json::object(vec![("deliveries", Value::Array(chunk))]);
        let answered = post(team, "/v1/routines/notices/ack", &body).await?;
        if !json::equal(
            &answered,
            &json::object(vec![("acknowledged", Value::Bool(true))]),
        ) {
            return Err(RoutineTeamError);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
