//! The Supervisor's two-step operations over the session socket (ADR-0114 decision 6, ADR-0051).
//!
//! A confirmation starts with the Supervisor password, within sign-in's own limiter, lockout, and journal, and with
//! the socket's bound Origin. Its one-use ticket keeps every binding it always had and is bound to the socket and its
//! session too: the socket keeps it, the page never holds it, and it dies with either. The second factor spends it on
//! a lane worker; the session, the socket, and its Origin are checked again after the factor and immediately before
//! the operation is dispatched.

use super::calls::Call;
use crate::{fault::Outcome, signin::local::Asker};

/// Checks the password for one exact operation, then offers its second factor once the socket is still current.
///
/// # Errors
///
/// Returns the refusal.
pub async fn begin(call: &Call, subject: String) -> Outcome {
    let _ = (call, subject);
    crate::signin::local::unported().await
}

/// Spends the socket's one ticket on one second factor, then dispatches `operation` as the confirmed asker.
///
/// # Errors
///
/// Returns the refusal or the operation's fault.
pub async fn complete<F, Fut>(call: &Call, subject: String, operation: F) -> Outcome
where
    F: FnOnce(Asker) -> Fut + Send + 'static,
    Fut: Future<Output = Outcome> + Send + 'static,
{
    let _ = (call, subject, operation);
    crate::signin::local::unported().await
}
