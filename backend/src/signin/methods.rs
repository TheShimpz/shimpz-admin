//! The Supervisor's security methods of the session socket: the summary and the confirmed operations.

use crate::{fault::Outcome, session::calls::Call};

/// `security_summary`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn security_summary(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `security_acknowledge`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn security_acknowledge(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `recovery_codes_confirmation`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn recovery_codes_confirmation(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `recovery_codes_replace`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn recovery_codes_replace(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `supervisor_key_confirmation`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn supervisor_key_confirmation(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `supervisor_key_rotate`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn supervisor_key_rotate(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}
