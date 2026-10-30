//! The Supervisor's security methods of the session socket: the summary and the confirmed operations.

use std::sync::Arc;

use super::{
    local::{RECOVERY_CODES_SUBJECT, SUPERVISOR_KEY_SUBJECT, operation},
    security,
};
use crate::{
    fault::{Fault, Outcome, Reply},
    session::{calls::Call, stepup},
};

/// `security.summary`.
///
/// # Errors
///
/// Returns 401 once the session ended, or the store's fault.
pub async fn security_summary(call: &Call) -> Outcome {
    let socket = Arc::clone(&call.socket);
    call.on_lane(async move { security::summary_for(socket.app(), socket.cookie()).map(Reply::ok) })
        .await
}

/// `security.acknowledge`.
///
/// # Errors
///
/// As [`security_summary`].
pub async fn security_acknowledge(call: &Call) -> Outcome {
    let socket = Arc::clone(&call.socket);
    let payload = call.body().clone();
    call.on_lane(async move {
        let Some(count) = security::acknowledged_count(&payload) else {
            return Err(Fault::detail(
                400,
                "request body must contain only a positive acknowledged count",
            ));
        };
        let summary = security::acknowledge(socket.app(), socket.cookie(), count)?;
        socket.app().topics.changed("security/summary");
        Ok(Reply::ok(summary))
    })
    .await
}

/// A security change Admin completed changes the session's sign-in security summary.
fn announced(app: &crate::app::App, outcome: Outcome) -> Outcome {
    if outcome.as_ref().is_ok_and(Reply::success) {
        app.topics.changed("security/summary");
    }
    outcome
}

/// `recovery_codes.confirmation`.
///
/// # Errors
///
/// Returns the lane's fault.
pub async fn recovery_codes_confirmation(call: &Call) -> Outcome {
    stepup::begin(call, RECOVERY_CODES_SUBJECT.to_owned()).await
}

/// `recovery_codes.replace`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn recovery_codes_replace(call: &Call) -> Outcome {
    let app = Arc::clone(call.app());
    stepup::complete(
        call,
        RECOVERY_CODES_SUBJECT.to_owned(),
        move |asker| async move {
            let replaced =
                operation::regenerate_recovery_codes(&app, asker.origin.as_deref()).await;
            announced(&app, replaced)
        },
    )
    .await
}

/// `supervisor_key.confirmation`.
///
/// # Errors
///
/// Returns the lane's fault.
pub async fn supervisor_key_confirmation(call: &Call) -> Outcome {
    stepup::begin(call, SUPERVISOR_KEY_SUBJECT.to_owned()).await
}

/// `supervisor_key.rotate`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn supervisor_key_rotate(call: &Call) -> Outcome {
    let app = Arc::clone(call.app());
    stepup::complete(
        call,
        SUPERVISOR_KEY_SUBJECT.to_owned(),
        move |asker| async move {
            let rotated = operation::rotate_supervisor_key(&app, &asker).await;
            announced(&app, Ok(rotated))
        },
    )
    .await
}
