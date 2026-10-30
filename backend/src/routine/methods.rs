//! A Team's Routines over the session socket (ADR-0114 tranche (c), ADR-0086).

use crate::{fault::Outcome, session::calls::Call};

/// `routines_list`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_list(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_pause`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_pause(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_resume`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_resume(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_deletion`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_deletion(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_delete`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_delete(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_plan_steps`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_plan_steps(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_run_steps`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_run_steps(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_diagnostics`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_diagnostics(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_card`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_card(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_card_answer`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_card_answer(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_challenge`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_challenge(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_human`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_human(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_integrations`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_integrations(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_proposal_confirm`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_proposal_confirm(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `routines_proposal_revoke`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn routines_proposal_revoke(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}
