//! Metadata-only progress events at the Admin browser boundary: Admin's own spans and Team's relayed steps.

use team_protocol::progress::{self as progress_contract, MAX_ELAPSED_MS, PHASES, STATES};

use crate::json::{self, Value};

/// Admin's own phases.
pub const ADMIN_PHASES: [&str; 2] = ["admin-preparation", "reply-validation"];
/// The most public progress events of one turn.
pub const MAX_PUBLIC_PROGRESS_EVENTS: usize = 2_048 + 4;

/// The event is not a public progress event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidProgress;

fn admin_event(event: &Value) -> Result<Value, InvalidProgress> {
    let state = json::get_str(event, "state").unwrap_or_default();
    let finished = state == "finished";
    let expected: &[&str] = if finished {
        &["phase", "state", "elapsed_ms"]
    } else {
        &["phase", "state"]
    };
    if !json::has_exactly(event, expected) || !STATES.contains(&state) {
        return Err(InvalidProgress);
    }
    if finished
        && !json::get(event, "elapsed_ms")
            .and_then(json::as_int)
            .is_some_and(|elapsed| (0..=MAX_ELAPSED_MS).contains(&elapsed))
    {
        return Err(InvalidProgress);
    }
    Ok(event.clone())
}

/// One Team event with its sequence removed.
///
/// # Errors
///
/// Returns [`InvalidProgress`] for a value outside Team's progress contract.
pub fn team_event(value: &Value) -> Result<Value, InvalidProgress> {
    let mut event = progress_contract::canonical_event(value).map_err(|_| InvalidProgress)?;
    json::remove(&mut event, "seq");
    Ok(event)
}

/// One metadata-only event at the Admin browser boundary, its origin first.
///
/// # Errors
///
/// Returns [`InvalidProgress`] for any other value.
pub fn canonical_public_progress(value: &Value) -> Result<Value, InvalidProgress> {
    json::members(value).ok_or(InvalidProgress)?;
    let origin = json::get_str(value, "origin").unwrap_or_default();
    let phase = json::get_str(value, "phase").unwrap_or_default();
    let admin_phase = ADMIN_PHASES.contains(&phase);
    if !matches!(origin, "admin" | "team") || !(admin_phase || PHASES.contains(&phase)) {
        return Err(InvalidProgress);
    }
    if (origin == "admin") != admin_phase {
        return Err(InvalidProgress);
    }
    let event = json::without(value, "origin");
    let event = if origin == "admin" {
        admin_event(&event)?
    } else {
        let mut sequenced = vec![("seq".to_owned(), json::int(1))];
        sequenced.extend(json::members(&event).unwrap_or_default().iter().cloned());
        team_event(&Value::Object(sequenced))?
    };
    let mut members = vec![("origin".to_owned(), json::text(origin))];
    members.extend(json::members(&event).unwrap_or_default().iter().cloned());
    Ok(Value::Object(members))
}
