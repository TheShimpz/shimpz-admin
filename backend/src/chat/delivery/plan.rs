//! Delivery of one admitted Assistant install plan: its card while each item installs, its terminal committed to the
//! Team's history, then either the end of the turn or the original task's dispatch.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tokio::sync::mpsc;

use crate::{
    chat::{
        assistants::{
            plan::{self, AlreadyInstalled, Outcome, Plan, Preparation},
            proposal::reference_from_item,
        },
        connection::{Pending, Turn},
        gate::Refused,
        lifecycle,
        projection::error_terminal,
        socket::{Ctx, stop::finish_active_turn, turn::continue_team_turn},
    },
    history::delivery::blocking,
    json::{self, Value},
    lanes::Ended,
};

fn remember_single_install(ctx: &Ctx, assistants: &[Value]) {
    let reference = match assistants {
        [item] => reference_from_item(item),
        _ => None,
    };
    ctx.connection().assistant_reference = reference;
}

fn remember_terminal_plan(ctx: &Ctx, plan: &Plan, outcome: &Outcome) {
    let named: Vec<Value> = plan
        .lifecycle_ids
        .iter()
        .filter_map(|id| {
            outcome
                .assistants
                .iter()
                .find(|item| json::get_str(item, "id") == Some(id.as_str()))
                .cloned()
        })
        .collect();
    let complete = named.len() == plan.lifecycle_ids.len();
    remember_single_install(ctx, if complete { &named } else { &[] });
}

fn failed(plan: &Plan, items: Vec<Value>, status: u16) -> Outcome {
    let _ = plan;
    Outcome {
        state: "failed",
        assistants: items,
        status: Some(status),
        code: None,
    }
}

/// Runs a plan's job, showing each item's state as it changes.
async fn run_job(ctx: &Ctx, turn: &Arc<Turn>, plan: &Plan) -> Outcome {
    let initial = plan::initial_items(plan);
    ctx.send(&plan::event(
        plan,
        "planned",
        initial.clone(),
        None,
        None,
        None,
    ));
    let stop = Arc::new(AtomicBool::new(false));
    turn.state().lifecycle_stop = Some(Arc::clone(&stop));
    let (sender, mut updates) = mpsc::unbounded_channel();
    let report = Arc::new(move |items: Vec<Value>| {
        let _ = sender.send(items);
    });
    let Some(job) = lifecycle::submit_plan(ctx, plan, &stop, report) else {
        return failed(plan, initial, 429);
    };
    {
        let mut state = turn.state();
        state.future = Some(Arc::new(job.clone()) as Arc<dyn Pending>);
        state.operation = "assistant-plan";
    }
    let ended = loop {
        tokio::select! {
            biased;
            update = updates.recv() => match update {
                Some(items) => ctx.send(&plan::event(plan, "installing", items, None, None, None)),
                None => break job.wait().await,
            },
            ended = job.wait() => break ended,
        }
    };
    while let Ok(items) = updates.try_recv() {
        if ctx.closed() {
            break;
        }
        ctx.send(&plan::event(plan, "installing", items, None, None, None));
    }
    match ended {
        Ended::Done(outcome) => outcome,
        Ended::Cancelled | Ended::Panicked => {
            stop.store(true, Ordering::SeqCst);
            failed(plan, initial, 502)
        }
    }
}

async fn commit_install(ctx: &Ctx, turn: &Arc<Turn>, terminal: &Value) -> bool {
    let Some(history_id) = turn.state().history_id.clone() else {
        return true;
    };
    let (team_id, terminal) = (ctx.team_id().to_owned(), terminal.clone());
    blocking(ctx.history(), move |store| {
        store.append_install(&team_id, &history_id, &terminal)
    })
    .await
        == Ok(true)
}

fn with_scope(payload: &Value, dispatch_ids: &[String]) -> Value {
    let mut dispatched = payload.clone();
    json::set(
        &mut dispatched,
        "assistant_ids",
        json::strings(dispatch_ids.iter().map(String::as_str)),
    );
    dispatched
}

async fn deliver_admitted(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
    plan: &Plan,
) -> Result<(), Refused> {
    let outcome = run_job(ctx, turn, plan).await;
    if ctx.closed() {
        return Ok(());
    }
    let installed = outcome.state == "installed";
    let continuation = if installed && plan.terminal {
        "none"
    } else {
        "dispatch"
    };
    let terminal = plan::event(
        plan,
        outcome.state,
        outcome.assistants.clone(),
        outcome.status,
        outcome.code,
        installed.then_some(continuation),
    );
    if !commit_install(ctx, turn, &terminal).await {
        ctx.connection().assistant_reference = None;
        finish_active_turn(
            ctx,
            turn,
            &error_terminal(503, "Admin chat history is unavailable"),
        )
        .await;
        return Ok(());
    }
    if installed && continuation == "none" {
        remember_terminal_plan(ctx, plan, &outcome);
    } else {
        ctx.connection().assistant_reference = None;
    }
    if !installed || continuation == "none" {
        finish_active_turn(ctx, turn, &terminal).await;
        return Ok(());
    }
    ctx.send(&terminal);
    continue_team_turn(ctx, turn, &with_scope(payload, &plan.dispatch_ids)).await
}

async fn deliver_already_installed(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
    result: &AlreadyInstalled,
) -> Result<(), Refused> {
    let terminal = plan::already_installed_event(result);
    if !commit_install(ctx, turn, &terminal).await {
        ctx.connection().assistant_reference = None;
        finish_active_turn(
            ctx,
            turn,
            &error_terminal(503, "Admin chat history is unavailable"),
        )
        .await;
        return Ok(());
    }
    if result.dispatch_ids.is_empty() {
        remember_single_install(ctx, &result.assistants);
        finish_active_turn(ctx, turn, &terminal).await;
        return Ok(());
    }
    ctx.connection().assistant_reference = None;
    ctx.send(&terminal);
    continue_team_turn(ctx, turn, &with_scope(payload, &result.dispatch_ids)).await
}

/// Delivers one already-resolved preparation without opening another worker lane.
///
/// # Errors
///
/// Returns [`Refused`] when the gate let a continued turn not start again.
pub async fn deliver_result(
    ctx: &Ctx,
    turn: &Arc<Turn>,
    payload: &Value,
    preparation: Preparation,
) -> Result<(), Refused> {
    if let Some(status) = preparation.error_status {
        ctx.connection().assistant_reference = None;
        let detail = preparation
            .error_code
            .unwrap_or("Assistant capability planning could not complete; retry the task");
        finish_active_turn(ctx, turn, &error_terminal(status, detail)).await;
        return Ok(());
    }
    if preparation.plan.is_none() && preparation.already_installed.is_none() {
        return continue_team_turn(ctx, turn, payload).await;
    }
    if turn.state().stop_requested {
        ctx.connection().assistant_reference = None;
        finish_active_turn(
            ctx,
            turn,
            &json::object(vec![("type", json::text("stopped"))]),
        )
        .await;
        return Ok(());
    }
    if let Some(result) = &preparation.already_installed {
        return deliver_already_installed(ctx, turn, payload, result).await;
    }
    match &preparation.plan {
        Some(plan) => deliver_admitted(ctx, turn, payload, plan).await,
        None => Ok(()),
    }
}
