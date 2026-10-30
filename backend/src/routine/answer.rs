//! A Local Supervisor answers a frozen Routine run (ADR-0086) exactly as chat answers a paused turn.
//!
//! Opening a frozen run's decision asks Team for a fresh one-use challenge; Admin keeps its request until it expires, so
//! an answer is checked against it and an authentication request is verified here, as in chat, before the run resumes
//! under the Supervisor's session. A run asks no model, so the answer carries no model key (ADR-0092).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use team_protocol::{routine_run, websocket::canonical_human_response};

use super::{manage, team::RESUME_TIMEOUT_SECONDS};
use crate::{
    chat::human::{self, ActionPasswords},
    fault::{Fault, Reply},
    json::{self, Value},
    sync::lock,
    team::{
        bridge::MAX_CHAT_JSON_BODY_BYTES,
        transport::{Bindings, Options, Team},
    },
    time::clock::Clock,
};

/// The most challenges Admin keeps open.
pub const MAX_OPEN_CHALLENGES: usize = 64;
/// Teams whose latest opening is tracked.
pub const MAX_TRACKED_GENERATIONS: usize = 4 * MAX_OPEN_CHALLENGES;
/// The most Teams with an opening in flight.
pub const MAX_OPENING_TEAMS: usize = MAX_OPEN_CHALLENGES;
/// The longest an opening waits for its Team's earlier one.
pub const OPENING_WAIT: Duration = Duration::from_secs(30);

type Key = (String, String, String);
/// One Team's opening lock and the openings holding or awaiting it.
type Opening = (Arc<tokio::sync::Mutex<()>>, usize);

struct Open {
    key: Key,
    deadline_ms: i64,
    request: Value,
}

#[derive(Default)]
struct Kept {
    open: Vec<Open>,
    generations: Vec<(String, u64)>,
    next: u64,
}

impl Kept {
    fn generation(&self, team: &str) -> Option<u64> {
        self.generations
            .iter()
            .find(|(known, _)| known == team)
            .map(|(_, generation)| *generation)
    }

    fn store(&mut self, now: i64, open: Open) {
        self.open
            .retain(|item| item.deadline_ms > now && item.key.0 != open.key.0);
        if self.open.len() >= MAX_OPEN_CHALLENGES {
            self.open.remove(0);
        }
        self.open.push(open);
    }
}

/// The challenges of frozen runs Admin opened, each Team's latest opening, and the openings in flight.
pub struct Challenges {
    clock: Arc<Clock>,
    kept: Mutex<Kept>,
    openings: Mutex<HashMap<String, Opening>>,
}

/// An answer Admin checked against its open challenge and authenticated, ready to resume its run.
#[derive(Clone, Debug)]
pub struct Answered {
    /// The Team.
    pub team_id: String,
    /// The run.
    pub run_id: String,
    /// The continuation.
    pub payload: Value,
    /// The assurance an authenticated answer carries.
    pub assurance: Option<Value>,
    /// The failure of a password Admin could not check.
    pub failure: Option<(u16, &'static str)>,
}

impl Challenges {
    /// No challenge open.
    #[must_use]
    pub fn new(clock: Arc<Clock>) -> Self {
        Self {
            clock,
            kept: Mutex::new(Kept::default()),
            openings: Mutex::new(HashMap::new()),
        }
    }

    /// Keeps a challenge Team just opened; Team cancelled that Team's earlier one.
    fn remember(&self, key: Key, deadline_ms: i64, request: Value) {
        let now = self.clock.monotonic_ms();
        let mut kept = lock(&self.kept);
        kept.generations.retain(|(team, _)| *team != key.0);
        kept.next += 1;
        let generation = kept.next;
        kept.generations.push((key.0.clone(), generation));
        while kept.generations.len() > MAX_TRACKED_GENERATIONS {
            kept.generations.remove(0);
        }
        kept.store(
            now,
            Open {
                key,
                deadline_ms,
                request,
            },
        );
    }

    /// Reopens a challenge after a rejected answer, unless the Team opened a newer one that cancelled it meanwhile.
    fn restore(&self, key: Key, deadline_ms: i64, request: Value, generation: Option<u64>) {
        let now = self.clock.monotonic_ms();
        let mut kept = lock(&self.kept);
        if generation.is_some() && kept.generation(&key.0) == generation {
            kept.store(
                now,
                Open {
                    key,
                    deadline_ms,
                    request,
                },
            );
        }
    }

    fn take(&self, key: &Key) -> Option<(i64, Value, Option<u64>)> {
        let mut kept = lock(&self.kept);
        let position = kept.open.iter().position(|item| item.key == *key)?;
        let open = kept.open.remove(position);
        let generation = kept.generation(&key.0);
        (open.deadline_ms > self.clock.monotonic_ms()).then_some((
            open.deadline_ms,
            open.request,
            generation,
        ))
    }

    /// The Team's opening lock, or `None` when too many Teams are opening.
    fn opening(&self, team: &str) -> Option<Arc<tokio::sync::Mutex<()>>> {
        let mut openings = lock(&self.openings);
        if !openings.contains_key(team) && openings.len() >= MAX_OPENING_TEAMS {
            return None;
        }
        let entry = openings
            .entry(team.to_owned())
            .or_insert_with(|| (Arc::new(tokio::sync::Mutex::new(())), 0));
        entry.1 += 1;
        Some(Arc::clone(&entry.0))
    }

    fn opened(&self, team: &str) {
        let mut openings = lock(&self.openings);
        if let Some(entry) = openings.get_mut(team) {
            entry.1 -= 1;
            if entry.1 == 0 {
                openings.remove(team);
            }
        }
    }

    /// A person opened a frozen run's decision: its fresh challenge, or that it waits for an Integration.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for an invalid id or opening.
    pub async fn open_challenge(
        &self,
        team: &Team,
        team_id: &str,
        run_id: &str,
        body: &Value,
    ) -> Result<Reply, Fault> {
        let (canonical, run) = manage::run_ids(team_id, run_id)?;
        let opening = routine_run::canonical_challenge_open(body)
            .ok_or_else(|| Fault::team_request("Routine challenge opening is invalid"))?;
        let busy = || Reply::new(409, json::code("routine-challenge-busy"));
        let Some(gate) = self.opening(&canonical) else {
            return Ok(busy());
        };
        let answer = match tokio::time::timeout(OPENING_WAIT, gate.lock()).await {
            Ok(_held) => self.open(team, &canonical, &run, &opening).await,
            Err(_) => Ok(busy()),
        };
        self.opened(&canonical);
        answer
    }

    async fn open(
        &self,
        team: &Team,
        canonical: &str,
        run: &str,
        opening: &Value,
    ) -> Result<Reply, Fault> {
        let path = format!("/v1/teams/{canonical}/routines/runs/{run}/challenge");
        let response = team.call("POST", &path, Some(opening)).await?;
        if response.status != 200 || json::members(&response.body).is_none() {
            return Ok(manage::projected(&response, |_| None));
        }
        let body = &response.body;
        if json::has_exactly(body, &["team_id", "run_id", "status", "trace_id"])
            && json::get_str(body, "status") == Some("integrations-required")
        {
            return Ok(manage::projected(&response, |value| {
                (json::get_str(value, "team_id") == Some(canonical)
                    && json::get_str(value, "run_id") == Some(run))
                .then(|| value.clone())
            }));
        }
        if json::get_str(body, "run_id") != Some(run) {
            return Ok(manage::invalid());
        }
        let Ok(projected) = human::project(&json::without(body, "run_id"), canonical) else {
            return Ok(manage::invalid());
        };
        if projected.get("file").is_some()
            || projected.get("input").is_some()
            || projected.get("locale") != opening.get("locale")
        {
            return Ok(manage::invalid());
        }
        let expires = projected
            .get("expires_in")
            .and_then(json::as_int)
            .unwrap_or_default();
        let deadline = self.clock.monotonic_ms() + expires.saturating_mul(1000);
        let challenge_id = json::get_str(&projected, "challenge_id")
            .unwrap_or_default()
            .to_owned();
        let request = projected.get("request").cloned().unwrap_or(Value::Null);
        self.remember(
            (canonical.to_owned(), run.to_owned(), challenge_id),
            deadline,
            request,
        );
        Ok(Reply::ok(json::object(vec![
            ("team_id", json::text(canonical)),
            ("run_id", json::text(run)),
            ("status", json::text("human-required")),
            ("challenge", challenge(&projected)),
        ])))
    }

    /// One exact answer to the run's open challenge, authenticated as in chat, or why it cannot resume the run.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for an invalid id or a frame outside the protocol.
    pub async fn authenticated(
        &self,
        passwords: &ActionPasswords,
        team_id: &str,
        run_id: &str,
        frame: &Value,
    ) -> Result<Result<Answered, Reply>, Fault> {
        let refused = || Fault::team_request("human response is invalid");
        let (canonical, run) = manage::run_ids(team_id, run_id)?;
        let canonical_frame = canonical_human_response(frame).map_err(|_| refused())?;
        let challenge_id = json::get_str(&canonical_frame, "challenge_id")
            .unwrap_or_default()
            .to_owned();
        let key = (canonical.clone(), run.clone(), challenge_id);
        let Some((deadline, request, generation)) = self.take(&key) else {
            return Ok(Err(Reply::new(409, json::code("human-request-expired"))));
        };
        let answered = human::response_payload(frame, &request, passwords)
            .await
            .map_err(|_| refused())?;
        if let Some(rejection) = answered.rejection {
            // A wrong password keeps the challenge open until its own expiry for another attempt, as in chat.
            self.restore(key, deadline, request, generation);
            let reason = rejection.get("reason").cloned().unwrap_or(Value::Null);
            let body = json::merged(&json::object(vec![("code", reason)]), &rejection);
            return Ok(Err(Reply::new(409, body)));
        }
        Ok(Ok(Answered {
            team_id: canonical,
            run_id: run,
            payload: answered.payload.unwrap_or(Value::Null),
            assurance: answered.assurance,
            failure: answered.failure,
        }))
    }
}

/// The challenge frame a page shows: its fields and presentation, in the protocol's order.
fn challenge(projected: &Value) -> Value {
    let mut presentation = human::PRESENTATION_FIELDS;
    presentation.sort_unstable();
    let mut members = vec![("type".to_owned(), json::text("human-required"))];
    for name in human::CHALLENGE_FIELDS.iter().chain(presentation.iter()) {
        if let Some(value) = projected.get(name) {
            members.push(((*name).to_owned(), value.clone()));
        }
    }
    Value::Object(members)
}

async fn resume(
    team: &Team,
    canonical: &str,
    run: &str,
    action: &str,
    payload: &Value,
    assurance: Option<Value>,
) -> Result<Reply, Fault> {
    let options = Options {
        timeout: Duration::from_secs(u64::try_from(RESUME_TIMEOUT_SECONDS).unwrap_or(0)),
        body_limit: MAX_CHAT_JSON_BODY_BYTES,
        bindings: Bindings {
            assurance,
            ..Bindings::default()
        },
        ..Options::default()
    };
    let path = format!("/v1/teams/{canonical}/routines/runs/{run}/{action}");
    let response = team
        .call_stream("POST", &path, payload, options, &|_| {})
        .await?;
    Ok(manage::projected(&response, |value| {
        routine_run::canonical_segment_answer(value)
            .filter(|admitted| {
                json::get_str(admitted, "team_id") == Some(canonical)
                    && json::get_str(admitted, "run_id") == Some(run)
            })
            .cloned()
    }))
}

/// Team's answer as the run resumes, or ends denied.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for a payload Admin refuses to send.
pub async fn resume_answered(team: &Team, answered: &Answered) -> Result<Reply, Fault> {
    resume(
        team,
        &answered.team_id,
        &answered.run_id,
        "human",
        &answered.payload,
        answered.assurance.clone(),
    )
    .await
}

/// What the person learns: an Action password Admin could not check denied the run, which says so as a failure.
#[must_use]
pub fn answered_outcome(answered: &Answered, resumed: Reply) -> Reply {
    match answered.failure {
        Some((status, _)) => Reply::new(status, json::code("human-authentication-unavailable")),
        None => resumed,
    }
}

/// After the Integration is connected, the run continues from where it froze.
///
/// # Errors
///
/// Returns [`Fault::TeamRequest`] for an invalid id.
pub async fn resume_integrations(team: &Team, team_id: &str, run_id: &str) -> Result<Reply, Fault> {
    let (canonical, run) = manage::run_ids(team_id, run_id)?;
    resume(team, &canonical, &run, "integrations", &json::empty(), None).await
}

#[cfg(test)]
mod tests;
