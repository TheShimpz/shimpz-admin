//! Chat work under the Space's chat gate (ADR-0119): wait for a slot, run, and say where it waits meanwhile.

use std::{future::Future, sync::Arc};

use crate::{
    chat::{
        connection::Turn,
        gate::{Position, Refused},
        local::Answer,
        projection::error_terminal,
        socket::{Ctx, stop::finish_active_turn},
    },
    json::{self, Value},
    team::{bridge, transport::Team},
};

/// Team's current chat limit, read under the waiting operation's own authority.
pub fn read_limit(team: &Team) -> impl Future<Output = Option<i64>> + Send + 'static {
    let team = team.clone();
    async move {
        let response = bridge::chat_limit(&team).await;
        if response.status != 200 {
            return None;
        }
        response.get("limit").and_then(json::as_int)
    }
}

/// The terminal a page is told when the gate let its operation not start.
#[must_use]
pub fn refusal(error: Refused) -> Value {
    match error {
        Refused::QueueFull => error_terminal(429, "the chat queue is full"),
        Refused::LimitUnavailable => error_terminal(503, "the Space chat limit is unavailable"),
        Refused::AuthorityEnded => {
            error_terminal(401, "the session ended before the work could start")
        }
    }
}

/// Whether Team refused the work only because the Space runs as many chat turns as its limit.
#[must_use]
pub fn space_busy(answer: Option<&Answer>) -> bool {
    answer.is_some_and(|answer| {
        answer.reply.status == 429 && json::equal(&answer.reply.body, &json::code("space-busy"))
    })
}

/// Before the operation starts after waiting: the authority it was admitted under is still current.
///
/// # Errors
///
/// Returns [`Refused::AuthorityEnded`] otherwise.
pub fn authorized(ctx: &Ctx) -> Result<(), Refused> {
    match ctx.run.authority() {
        Some(authority) if !authority.current() => Err(Refused::AuthorityEnded),
        _ => Ok(()),
    }
}

/// Tells the pages watching the run where its operation waits, or that it runs.
#[must_use]
pub fn position(ctx: &Ctx) -> Position {
    let run = Arc::downgrade(&ctx.run);
    Arc::new(move |place| {
        if let Some(run) = run.upgrade() {
            run.set_position(place);
        }
    })
}

/// Gives the turn's slot back however its work ends.
struct SlotGuard<'a>(&'a Arc<Turn>);

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        let slot = self.0.state().slot.take();
        drop(slot);
    }
}

/// Runs one turn's work under a slot of the Space's chat gate, waiting for it first.
pub async fn run<F, W>(ctx: &Ctx, turn: &Arc<Turn>, work: W)
where
    W: FnOnce() -> F,
    F: Future<Output = Result<(), Refused>>,
{
    let gate = Arc::clone(&ctx.app.domains.chat.gate);
    let guard = SlotGuard(turn);
    let outcome = match gate.slot(position(ctx), read_limit(&ctx.team)).await {
        Ok(held) => {
            turn.state().slot = Some(Arc::new(tokio::sync::Mutex::new(held)));
            match authorized(ctx) {
                Ok(()) => work().await,
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    drop(guard);
    if let Err(error) = outcome {
        finish_active_turn(ctx, turn, &refusal(error)).await;
    }
}
