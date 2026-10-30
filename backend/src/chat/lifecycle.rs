//! Run-scoped automatic install plans and confirmed destructive lifecycle work: the uninstall proposal a page decides
//! with its next message, and the approved uninstall Team executes.

use std::sync::{Arc, atomic::AtomicBool};

use super::{
    assistants::{
        plan::{self, Outcome, Plan},
        proposal::{self, AssistantReference, Decision, UninstallProposal, UninstallTarget},
        route::{self, Context, Prepared, RouteError},
        uninstall::{self, UninstallResult},
    },
    connection::{Connection, Operation, Pending, TaskHandle},
    socket::Ctx,
};
use crate::{
    command::log,
    history::delivery::blocking,
    json::{self, Value},
    lanes::{Ended, Job},
    sync::lock,
};

fn files_attached(payload: &Value) -> bool {
    payload
        .get("files")
        .and_then(json::as_array)
        .is_some_and(|files| !files.is_empty())
}

fn decision(payload: &Value) -> Decision {
    if files_attached(payload) {
        return Decision::Ambiguous;
    }
    proposal::classify_uninstall_confirmation(json::get_str(payload, "message").unwrap_or_default())
}

/// Whether a message answers the pending proposal, so it keeps the proposal's history turn.
#[must_use]
pub fn reuses_history(connection: &Connection, payload: &Value) -> bool {
    connection.lifecycle_proposal.is_some()
        && !files_attached(payload)
        && decision(payload) != Decision::Ambiguous
}

/// A proposed uninstall keeps its history turn for the answer that decides it.
pub fn retain_history(connection: &mut Connection, history_id: Option<String>, event: &Value) {
    if json::get_str(event, "type") == Some("assistant-uninstall")
        && json::get_str(event, "state") == Some("proposed")
    {
        connection.admitted_history_id = history_id;
    }
}

/// The displayed identity only: the registry summary is Team's English catalog text and is never shown.
#[must_use]
pub fn assistant_identity(proposal: &UninstallProposal) -> Value {
    json::object(vec![
        ("id", json::text(&proposal.assistant.assistant_id)),
        ("name", json::text(&proposal.assistant.name)),
        ("version", json::text(&proposal.assistant_version)),
        ("creator", json::text(&proposal.creator)),
        ("provenance", json::text(&proposal.provenance)),
    ])
}

fn proposal_event(proposal: &UninstallProposal) -> Value {
    json::object(vec![
        ("type", json::text("assistant-uninstall")),
        ("state", json::text("proposed")),
        ("proposal_id", json::text(&proposal.proposal_id)),
        ("team_id", json::text(&proposal.team_id)),
        (
            "expires_in",
            json::int(proposal::UNINSTALL_PROPOSAL_TTL_SECONDS),
        ),
        ("assistant", assistant_identity(proposal)),
    ])
}

fn event(proposal: &UninstallProposal, state: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut members = vec![
        ("type", json::text("assistant-uninstall")),
        ("state", json::text(state)),
        ("proposal_id", json::text(&proposal.proposal_id)),
        ("assistant_id", json::text(&proposal.assistant.assistant_id)),
    ];
    members.extend(fields);
    json::object(members)
}

fn history_error() -> Value {
    json::object(vec![
        ("type", json::text("error")),
        ("status", json::int(503)),
        ("detail", json::text("Admin chat history is unavailable")),
    ])
}

/// Admits one complete structured preparation of a fresh chat objective on the plan lane.
#[must_use]
pub fn submit_route(
    ctx: &Ctx,
    payload: &Value,
    context: Context,
) -> Option<Job<Result<Prepared, RouteError>>> {
    let (app, team, team_id, payload) = (
        Arc::clone(&ctx.app),
        ctx.team.clone(),
        ctx.team_id().to_owned(),
        payload.clone(),
    );
    ctx.app
        .domains
        .chat
        .lanes
        .plan
        .submit(async move { route::prepare(&app, &team, &team_id, &payload, context).await })
        .ok()
}

/// Admits one reconnect objective through the same structured route, without destructive lifecycle work.
#[must_use]
pub fn submit_resume(ctx: &Ctx, payload: &Value) -> Option<Job<Result<Prepared, RouteError>>> {
    let (app, team, team_id, payload) = (
        Arc::clone(&ctx.app),
        ctx.team.clone(),
        ctx.team_id().to_owned(),
        payload.clone(),
    );
    ctx.app
        .domains
        .chat
        .lanes
        .plan
        .submit(async move { route::prepare_resume(&app, &team, &team_id, &payload).await })
        .ok()
}

/// Admits one complete sequential plan before any item starts.
#[must_use]
pub fn submit_plan(
    ctx: &Ctx,
    plan: &Plan,
    stopped: &Arc<AtomicBool>,
    progress: Arc<dyn Fn(Vec<Value>) + Send + Sync>,
) -> Option<Job<Outcome>> {
    let (app, team, plan, stopped) = (
        Arc::clone(&ctx.app),
        ctx.team.clone(),
        plan.clone(),
        Arc::clone(stopped),
    );
    ctx.app
        .domains
        .chat
        .lanes
        .lifecycle
        .submit(async move { plan::execute(&app, &team, &plan, &stopped, progress.as_ref()).await })
        .ok()
}

/// One run-bound proposal and its deterministic public event.
#[must_use]
pub fn create_proposal(
    ctx: &Ctx,
    target: &UninstallTarget,
    locale: Option<&str>,
) -> Option<(UninstallProposal, Value)> {
    let proposal = proposal::create_uninstall_proposal(
        ctx.team_id(),
        target,
        locale,
        ctx.app.clock.monotonic_ms(),
    )?;
    let event = proposal_event(&proposal);
    Some((proposal, event))
}

async fn commit_uninstall(
    ctx: &Ctx,
    proposal: &UninstallProposal,
    history_id: Option<&str>,
    event: &Value,
) -> bool {
    let Some(history_id) = history_id.map(str::to_owned) else {
        return true;
    };
    let (team_id, assistant, event) = (
        proposal.team_id.clone(),
        assistant_identity(proposal),
        event.clone(),
    );
    let committed = blocking(ctx.history(), move |store| {
        store.append_uninstall(&team_id, &history_id, &assistant, &event)
    })
    .await;
    if committed != Ok(true) {
        log("error", "chat_uninstall_history_commit_failed");
        return false;
    }
    true
}

fn result_event(proposal: &UninstallProposal, result: Option<&UninstallResult>) -> Value {
    if let Some(UninstallResult {
        status: 200..=299,
        uninstalled: Some(uninstalled),
    }) = result
    {
        return event(
            proposal,
            "uninstalled",
            vec![
                ("team_id", json::text(&proposal.team_id)),
                ("uninstalled", Value::Bool(*uninstalled)),
            ],
        );
    }
    let status = result
        .map(|result| result.status)
        .filter(|status| (400..=599).contains(status))
        .unwrap_or(502);
    event(
        proposal,
        "failed",
        vec![("status", json::int(i64::from(status)))],
    )
}

async fn deliver(ctx: Ctx, operation: Arc<Operation>, job: Job<Option<UninstallResult>>, id: u64) {
    let result = match job.wait().await {
        Ended::Done(result) => result,
        Ended::Cancelled | Ended::Panicked => None,
    };
    if !ctx.closed() {
        let mut shown = result_event(&operation.proposal, result.as_ref());
        if !commit_uninstall(
            &ctx,
            &operation.proposal,
            operation.history_id.as_deref(),
            &shown,
        )
        .await
        {
            shown = history_error();
        }
        let uninstalled = json::get_str(&shown, "type") == Some("assistant-uninstall")
            && json::get_str(&shown, "state") == Some("uninstalled");
        ctx.connection().assistant_reference = uninstalled.then(|| AssistantReference {
            assistant_id: operation.proposal.assistant.assistant_id.clone(),
            name: operation.proposal.assistant.name.clone(),
        });
        ctx.send(&shown);
    }
    let mine = lock(&operation.delivery)
        .as_ref()
        .is_some_and(|task| task.id == id);
    let mut connection = ctx.connection();
    if mine
        && connection
            .lifecycle
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &operation))
    {
        connection.lifecycle = None;
    }
}

async fn dispatch(ctx: &Ctx, proposal: UninstallProposal, history_id: Option<String>) {
    ctx.send(&event(&proposal, "uninstalling", Vec::new()));
    let (app, team, executed) = (Arc::clone(&ctx.app), ctx.team.clone(), proposal.clone());
    let job = ctx
        .app
        .domains
        .chat
        .lanes
        .lifecycle
        .submit(async move { uninstall::uninstall(&app, &team, &executed).await.ok() });
    let Ok(job) = job else {
        let mut shown = event(&proposal, "failed", vec![("status", json::int(429))]);
        if !commit_uninstall(ctx, &proposal, history_id.as_deref(), &shown).await {
            shown = history_error();
        }
        ctx.connection().assistant_reference = None;
        ctx.send(&shown);
        return;
    };
    let operation = Arc::new(Operation {
        proposal,
        future: Arc::new(job.clone()) as Arc<dyn Pending>,
        delivery: std::sync::Mutex::new(None),
        history_id,
    });
    ctx.connection().lifecycle = Some(Arc::clone(&operation));
    let (task_ctx, task_operation) = (ctx.clone(), Arc::clone(&operation));
    let task = TaskHandle::spawn(move |id| deliver(task_ctx, task_operation, job, id));
    *lock(&operation.delivery) = Some(task);
}

async fn ended_proposal(
    ctx: &Ctx,
    proposal: &UninstallProposal,
    state: &str,
    history_id: Option<String>,
) {
    let mut shown = event(proposal, state, Vec::new());
    if !commit_uninstall(ctx, proposal, history_id.as_deref(), &shown).await {
        shown = history_error();
    }
    ctx.send(&shown);
}

/// Resolves one pending proposal before ordinary Brain dispatch; whether the message was its decision.
pub async fn resolve(ctx: &Ctx, payload: &Value) -> bool {
    let Some(proposal) = ctx.connection().lifecycle_proposal.clone() else {
        return false;
    };
    let decision = decision(payload);
    let valid = proposal.valid_for(ctx.team_id(), ctx.app.clock.monotonic_ms());
    let history_id = {
        let mut connection = ctx.connection();
        connection.lifecycle_proposal = None;
        if !valid || decision != Decision::Confirm {
            connection.assistant_reference = None;
        }
        (decision != Decision::Ambiguous)
            .then(|| connection.take_history_id())
            .flatten()
    };
    match (valid, decision) {
        (_, Decision::Ambiguous) => false,
        (false, _) => {
            ended_proposal(ctx, &proposal, "expired", history_id).await;
            true
        }
        (true, Decision::Confirm) => {
            dispatch(ctx, proposal, history_id).await;
            true
        }
        (true, Decision::Cancel) => {
            ended_proposal(ctx, &proposal, "cancelled", history_id).await;
            true
        }
    }
}

/// Destroys the run's lifecycle authority and stops observing an admitted result.
pub async fn close(ctx: &Ctx) {
    let operation = {
        let mut connection = ctx.connection();
        connection.lifecycle_proposal = None;
        connection.lifecycle.clone()
    };
    let Some(operation) = operation else {
        return;
    };
    let _ = operation.future.cancel();
    let delivery = lock(&operation.delivery).clone();
    if let Some(delivery) = delivery {
        delivery.abort();
        delivery.wait().await;
    }
}
