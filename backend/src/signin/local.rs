//! The Local Supervisor's ceremonies (`local_auth`): sign-in, setup, recovery, passkeys, and the confirmed operations
//! a session socket begins and completes.

use zeroize::Zeroizing;

use super::{
    passkeys::Ceremony,
    tickets::{Binding, Purpose},
};
use crate::{
    app::App,
    fault::{Fault, Outcome},
    json::Value,
};

/// Who asks for a confirmed operation: the socket's bound Origin, its session cookie, and its ticket binding.
#[derive(Clone)]
pub struct Asker {
    /// The bound Origin.
    pub origin: Option<String>,
    /// The session cookie.
    pub session: Zeroizing<String>,
    /// The socket and session a ticket issued to the asker is bound to.
    pub binding: Binding,
}

/// The one second factor a confirmation is completed with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Factor {
    /// A TOTP code.
    Totp,
    /// A passkey assertion.
    Passkey,
}

/// Spends a pending operation ticket nobody will complete, and its passkey challenge with it.
pub fn discard_operation(app: &App, token: &str) {
    if token.is_empty() {
        return;
    }
    let _ = app.tickets.consume(token, Purpose::Operation, "", None);
    let _ = app.challenges.consume(token, Ceremony::Authentication);
}

/// Confirms the Supervisor password for a session-held destructive operation within sign-in's own budget and lockout.
///
/// # Errors
///
/// Returns 403 for a wrong password, or sign-in's own refusal.
pub async fn recheck_password(
    app: &App,
    origin: Option<&str>,
    password: &Value,
) -> Result<(), Fault> {
    let _ = (app, origin, password);
    unported().await.map(|_| ())
}

/// The one second factor a confirmation is completed with; any other body is the request's own 400.
///
/// # Errors
///
/// Returns 400 for any other body.
pub fn operation_factor(body: &Value) -> Result<(Factor, Value), Fault> {
    let _ = body;
    Err(Fault::Internal)
}

/// Placeholder outcome until the ceremonies land.
///
/// # Errors
///
/// Always.
pub async fn unported() -> Outcome {
    tokio::task::yield_now().await;
    Err(Fault::Internal)
}
