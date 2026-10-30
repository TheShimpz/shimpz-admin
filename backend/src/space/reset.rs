//! A Local Space reset across Supervisor and Team authority: Team deletes the Space, and Admin clears the chat history
//! and the saved Team order with it under the order lock.

use std::sync::Arc;

use crate::{
    fault::{Fault, Outcome, Reply},
    http::body,
    json::{self, Value},
    process::app::App,
    signin::{audit::Outcome as Journal, local, password::MAX_PASSWORD_CHARS},
    team::{bridge, history, order, transport::Team},
};

/// A Space reset body carries one password or one host capability.
pub const MAX_BODY_BYTES: usize = 8 * 1024;

/// The password a Space reset body carries.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn password(payload: &Value) -> Result<Value, Fault> {
    body::exact_fields(payload, &["password"])?;
    let password = payload
        .get("password")
        .and_then(json::as_str)
        .ok_or_else(|| Fault::detail(400, "request body must contain only password"))?;
    if !(1..=MAX_PASSWORD_CHARS).contains(&password.chars().count()) {
        return Err(Fault::detail(400, "Supervisor password is invalid"));
    }
    Ok(json::text(password))
}

/// Which Team boundary deletes the Space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deletion {
    /// The Supervisor's own Space deletion.
    Established,
    /// The bootstrap deletion of a Space with no Supervisor yet.
    Bootstrap,
}

/// Deletes the Space through `team`, then clears the history and the saved order; the `teams` topic changes.
pub async fn space_reset(app: &Arc<App>, team: &Team, deletion: Deletion) -> Reply {
    let response = {
        let _order = app.domains.team.order.lock().await;
        let cleaned = {
            let _history = history::lifecycle(app).await;
            let response = match deletion {
                Deletion::Established => bridge::reset_space(team).await,
                Deletion::Bootstrap => bridge::bootstrap_reset_space(team).await,
            };
            history::cleanup(response, || history::clear_all(app))
        };
        order::space_reset(&app.config.team_order_path, cleaned)
    };
    app.topics.changed("teams");
    response
}

/// Requires the current Supervisor password, within the sign-in budget and lockout, before the Space reset; every
/// Team's chat run ends with the reset Space (ADR-0119).
///
/// # Errors
///
/// Returns the body's or sign-in's refusal, or the journal's.
pub async fn authenticated(
    app: &Arc<App>,
    team: &Team,
    origin: Option<&str>,
    payload: &Value,
) -> Outcome {
    let password = password(payload)?;
    local::recheck_password(app, origin, &password).await?;
    // Journaled before Team, history, or the saved order changes: an unwritable journal refuses the reset.
    app.audit
        .record("space-reset", Journal::Ok, origin, None)
        .map_err(|_| Fault::Audit)?;
    let response = space_reset(app, team, Deletion::Established).await;
    if response.status == 200 {
        history::end_runs(app, None);
    }
    Ok(response)
}
