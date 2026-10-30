//! The Supervisor's two-step operations over the session socket (ADR-0114 decision 6, ADR-0051).
//!
//! A confirmation starts with the Supervisor password, within sign-in's own limiter, lockout, and journal, and with
//! the socket's bound Origin. Its one-use ticket keeps every binding it always had (the purpose, the exact operation
//! and its subject, the Origin, the factor generation, its expiry, and single consumption) and is bound to the socket
//! and its session too: the socket keeps it, the page never holds it, and it dies with either. The second factor
//! spends it on a lane worker; the session, the socket, and its Origin are checked again after the factor and
//! immediately before the operation is dispatched.

use std::sync::Arc;

use zeroize::Zeroizing;

use super::{
    calls::{self, Call},
    socket::Socket,
};
use crate::{
    fault::{Outcome, Reply},
    signin::local::{
        self, Asker, OperationRefused,
        operation::{self, Confirmation},
    },
};

fn asker(socket: &Socket) -> Asker {
    Asker {
        origin: Some(socket.origin().to_owned()),
        session: Zeroizing::new(socket.cookie().to_owned()),
        binding: socket.binding().clone(),
    }
}

fn refusal(error: &OperationRefused) -> Reply {
    local::operation_refusal(error)
}

/// On the lane worker: issues the operation's ticket, which the socket keeps, and offers its second factor.
///
/// A socket keeps one pending confirmation: one begun again replaces the one before it, which is spent at once. A
/// ticket issued as the socket closed is revoked here, since the socket's own revocation may have run first.
fn offer(socket: &Socket, subject: &str) -> Reply {
    let app = socket.app();
    let (offer, token) = match operation::offer_operation(app, &asker(socket), subject) {
        Ok(offered) => offered,
        Err(error) => return refusal(&error),
    };
    let earlier = socket.replace_ticket(token.clone());
    local::discard_operation(app, &earlier);
    if !socket.live() {
        local::discard_operation(app, &token);
        app.tickets.revoke(socket.binding());
    }
    Reply::new(202, offer)
}

/// Checks the password for one exact operation, then offers its second factor once the socket is still current.
///
/// # Errors
///
/// Returns the lane's fault; a refusal is the call's own answer.
pub async fn begin(call: &Call, subject: String) -> Outcome {
    let password = match operation::operation_password(call.body()) {
        Ok(password) => password.clone(),
        Err(fault) => return Ok(fault.reply()),
    };
    let asked = asker(&call.socket);
    if let Err(error) = operation::verify_operation_password(call.app(), &asked, &password).await {
        return Ok(refusal(&error));
    }
    let socket = Arc::clone(&call.socket);
    call.on_lane(async move { Ok(offer(&socket, &subject)) })
        .await
}

/// On the lane worker: the socket's Origin and session are still current, and then it is still open in its session.
async fn current(socket: &Arc<Socket>) -> bool {
    calls::current(socket).await && socket.live()
}

/// Spends the socket's one ticket on one second factor, then dispatches `operation` as the confirmed asker.
///
/// The ticket is spent whatever the second factor, and also when it was begun for another operation.
///
/// # Errors
///
/// Returns the operation's fault; a refusal is the call's own answer.
pub async fn complete<F, Fut>(call: &Call, subject: String, operation: F) -> Outcome
where
    F: FnOnce(Asker) -> Fut + Send + 'static,
    Fut: Future<Output = Outcome> + Send + 'static,
{
    let socket = Arc::clone(&call.socket);
    let body = call.body().clone();
    call.on_lane(async move {
        let (factor, value) = match local::operation_factor(&body) {
            Ok(factor) => factor,
            Err(fault) => return Ok(fault.reply()),
        };
        let confirmation = Confirmation {
            token: socket.take_ticket(),
            factor,
            value,
        };
        let asked = asker(&socket);
        let app = Arc::clone(socket.app());
        let confirmed =
            operation::confirm_operation(&app, &asked, &subject, &confirmation, current(&socket));
        match confirmed.await {
            Ok(()) => operation(asked).await,
            Err(error) => Ok(refusal(&error)),
        }
    })
    .await
}
