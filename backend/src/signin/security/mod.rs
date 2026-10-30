//! The Supervisor's own view of its sign-in security (ADR-0051).
//!
//! It holds the sign-in before this one and the refused attempts since (read back from the authentication journal),
//! the reported second-factor failures, and the recovery codes left. A successful sign-in reports the second-factor
//! attempts refused since the previous one until the Supervisor acknowledges them. An acknowledgment names how many
//! it saw, so a refusal that arrives while the report is on screen is never dismissed unseen.

use super::{local::state_fault, token};
use crate::{
    fault::Fault,
    json::{self, Value},
    process::app::App,
    record::StateError,
};

/// The largest count an acknowledgment names.
pub const MAX_SECOND_FACTOR_FAILURES: i64 = 1_000_000;

fn fault(error: StateError) -> Fault {
    match error {
        StateError::Totp => Fault::Internal,
        other => state_fault(&other),
    }
}

/// The sign-in before this session's and the refused attempts since, or `null` while the journal is unreadable.
fn history(app: &App, session: &str) -> Result<Value, Fault> {
    let secret = app.store.session_secret().map_err(fault)?;
    let evidence = token::verify(&app.sessions, &app.clock, &secret, session, false)
        .ok_or_else(|| Fault::detail(401, "unauthenticated"))?;
    let Ok(history) = app.audit.sign_in_history(evidence.issued_at) else {
        crate::process::command::log("warning", "sign_in_history_unavailable");
        return Ok(Value::Null);
    };
    let previous = history.previous.map_or(Value::Null, |(at, origin)| {
        json::object(vec![
            ("at", json::text(at)),
            ("origin", origin.map_or(Value::Null, json::text)),
        ])
    });
    Ok(json::object(vec![
        ("previous", previous),
        (
            "failures_since",
            json::int(i64::try_from(history.failures_since).unwrap_or(i64::MAX)),
        ),
    ]))
}

/// The sign-in security summary of the session `security.summary` and an acknowledgment answer.
///
/// # Errors
///
/// Returns 401 once the session ended, or the store's fault.
pub fn summary_for(app: &App, session: &str) -> Result<Value, Fault> {
    let failures = app
        .store
        .unacknowledged_second_factor_failures()
        .map_err(fault)?;
    let remaining = app.store.recovery_codes_remaining().map_err(fault)?;
    let history = history(app, session)?;
    Ok(json::object(vec![
        ("failed_second_factor_attempts", json::int(failures)),
        (
            "recovery_codes_remaining",
            json::int(i64::try_from(remaining).unwrap_or(i64::MAX)),
        ),
        ("sign_in_history", history),
    ]))
}

/// The positive count an acknowledgment names, as its only member.
#[must_use]
pub fn acknowledged_count(payload: &Value) -> Option<i64> {
    if !json::has_exactly(payload, &["acknowledged"]) {
        return None;
    }
    json::get(payload, "acknowledged")
        .and_then(json::as_int)
        .filter(|count| (1..=MAX_SECOND_FACTOR_FAILURES).contains(count))
}

/// Acknowledges exactly the refused attempts the Supervisor saw, and answers the summary after it.
///
/// # Errors
///
/// As [`summary_for`].
pub fn acknowledge(app: &App, session: &str, count: i64) -> Result<Value, Fault> {
    app.store
        .acknowledge_second_factor_failures(count)
        .map_err(fault)?;
    summary_for(app, session)
}

#[cfg(test)]
mod tests;
