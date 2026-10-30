//! Delivery of one structured Assistant intent preparation: guidance, an error, an uninstall proposal, an install
//! plan, or the Team turn itself; a routing failure never falls through to ordinary Brain.

use std::sync::{Arc, atomic::AtomicBool};

use super::{plan, terminal, uninstall};
use crate::{
    chat::{
        assistants::{
            guidance::Guidance,
            route::{Prepared, RouteError},
        },
        connection::{Turn, TurnState},
        gate::Refused,
        projection::error_terminal,
        socket::{Ctx, stop::finish_active_turn, turn::continue_team_turn},
    },
    history::{context::Entry, delivery},
    json::{self, Value},
    lanes::{Ended, Job},
};

/// Why a route's delivery ended early.
enum Failed {
    Route(RouteError),
    Refused(Refused),
    Cancelled,
}

impl From<Refused> for Failed {
    fn from(error: Refused) -> Self {
        Self::Refused(error)
    }
}

async fn deliver_guidance(ctx: &Ctx, turn: &Arc<Turn>, guidance: &Guidance) {
    let history_id = turn.state().history_id.clone();
    let store = Arc::clone(ctx.history());
    let event = match delivery::guidance(
        &store,
        ctx.team_id(),
        history_id.as_deref(),
        guidance.code,
        &guidance.reply,
    )
    .await
    {
        Ok(()) => {
            ctx.connection().assistant_reference = None;
            json::object(vec![
                ("type", json::text("assistant-guidance")),
                ("team_id", json::text(ctx.team_id())),
                ("code", json::text(guidance.code)),
                ("reply", json::text(&guidance.reply)),
            ])
        }
        Err(_) => error_terminal(503, "Admin chat history is unavailable"),
    };
    terminal::turn(ctx, turn, &event, false).await;
}

async fn result(job: &Job<Result<Prepared, RouteError>>) -> Result<Prepared, Failed> {
    match job.wait().await {
        Ended::Done(Ok(prepared)) => Ok(prepared),
        Ended::Done(Err(error)) => Err(Failed::Route(error)),
        Ended::Cancelled => Err(Failed::Cancelled),
        Ended::Panicked => Err(Failed::Route(RouteError::status(503))),
    }
}

fn stopped() -> Value {
    json::object(vec![("type", json::text("stopped"))])
}

async fn deliver_result(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
    job: &Job<Result<Prepared, RouteError>>,
    fallback: Option<&Value>,
) -> Result<(), Failed> {
    let prepared = result(job).await?;
    if ctx.closed() {
        return Ok(());
    }
    if turn.state().stop_requested {
        finish_active_turn(ctx, turn, &stopped()).await;
        return Ok(());
    }
    if let Some(guidance) = &prepared.guidance {
        deliver_guidance(ctx, turn, guidance).await;
        return Ok(());
    }
    if prepared.error_status.is_some() || prepared.intent == "unresolved" {
        let status = prepared.error_status.unwrap_or(422);
        finish_active_turn(
            ctx,
            turn,
            &error_terminal(status, "Assistant request could not be resolved"),
        )
        .await;
        return Ok(());
    }
    if prepared.intent == "assistant-uninstall" {
        let target = prepared
            .uninstall
            .ok_or(Failed::Route(RouteError::status(503)))?;
        uninstall::deliver_candidate(ctx, turn, &target).await;
        return Ok(());
    }
    let preparation = prepared
        .preparation
        .ok_or(Failed::Route(RouteError::status(503)))?;
    if let Some(fallback) = fallback
        && preparation.plan.is_none()
        && preparation.already_installed.is_none()
        && preparation.error_status.is_none()
    {
        continue_team_turn(ctx, turn, fallback).await?;
        return Ok(());
    }
    plan::deliver_result(ctx, turn, payload, preparation).await?;
    Ok(())
}

/// Delivers the closed route result.
///
/// # Errors
///
/// Returns [`Refused`] when the gate let a continued turn not start again.
pub async fn deliver(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
    job: &Job<Result<Prepared, RouteError>>,
    fallback: Option<&Value>,
) -> Result<(), Refused> {
    let outcome = deliver_result(ctx, turn, payload, job, fallback).await;
    let refused = match outcome {
        Err(Failed::Route(error)) => {
            if !ctx.closed() && !turn.state().terminal_sent {
                let event = error.event.unwrap_or_else(|| {
                    error_terminal(
                        error.status,
                        "Assistant routing is unavailable; retry the message",
                    )
                });
                finish_active_turn(ctx, turn, &event).await;
            }
            Ok(())
        }
        Err(Failed::Refused(error)) => Err(error),
        Ok(()) | Err(Failed::Cancelled) => Ok(()),
    };
    let mut connection = ctx.connection();
    if connection.is_active(turn) && turn.state().operation == "assistant-route" {
        connection.active = None;
    }
    refused
}

/// Makes the routed preparation of one sent message the run's active turn.
#[must_use]
pub fn begin(ctx: &Ctx, locale: &str, conversation: Vec<Entry>, request: Value) -> Arc<Turn> {
    let mut connection = ctx.connection();
    let turn = Turn::new(TurnState {
        operation: "assistant-route",
        locale: Some(locale.to_owned()),
        lifecycle_stop: Some(Arc::new(AtomicBool::new(false))),
        history_id: connection.take_history_id(),
        conversation,
        request: Some(request),
        ..TurnState::default()
    });
    connection.active = Some(Arc::clone(&turn));
    turn
}
