//! A page's sync: where the Team's paused chat is, an Integration continuation resumed under the Space's chat gate,
//! or that nothing is pending.

use std::sync::Arc;

use super::Ctx;
use crate::{
    chat::{
        connection::{Pending, TaskHandle},
        delivery::{
            gated,
            progress::{self, Watched},
            sync as sync_delivery,
            terminal::resumed,
        },
        local::{
            Answer,
            turn::{self as local_turn, Progress},
        },
        projection::{error_terminal, failed, integration_challenge_event},
    },
    fault::Fault,
    history::delivery,
    json::{self, Value},
    lanes::{Ended, Job},
    team::transport::Team,
};

/// What a sync restores.
#[derive(Clone)]
struct Snapshot {
    kind: &'static str,
    pending: Answer,
    continued: Option<Answer>,
    resume: Option<String>,
}

async fn snapshot(team: Team, team_id: String, locale: String) -> Result<Snapshot, Fault> {
    let pending = local_turn::pending_integrations(&team, &team_id).await?;
    let resume = integration_challenge_event(&pending, &team_id)
        .and_then(|challenge| json::get_str(&challenge, "challenge_id").map(str::to_owned));
    if resume.is_some() || !sync_delivery::is_empty_pending(&pending, &team_id) {
        return Ok(Snapshot {
            kind: "integration",
            pending,
            continued: None,
            resume,
        });
    }
    Ok(Snapshot {
        kind: "human",
        pending: local_turn::open_human(&team, &team_id, &locale).await?,
        continued: None,
        resume: None,
    })
}

/// Starts one continuation job with its progress reporter.
pub type Submit<'a> = &'a (dyn Fn(Progress) -> Option<Job<Result<Answer, Fault>>> + Send + Sync);

/// One continuation's run with its progress delivered; `None` when it ended without an answer.
async fn continue_once(
    ctx: &Ctx,
    job: &Job<Result<Answer, Fault>>,
    mut queue: progress::ProgressQueue,
) -> Option<Answer> {
    ctx.connection().continuation = Some(Arc::new(job.clone()) as Arc<dyn Pending>);
    let pending = ctx.connection().pending_history_id.clone();
    let recording = progress::receipt_delivery(&mut ctx.connection(), pending.as_deref(), false);
    let run = Arc::clone(&ctx.run);
    let watched = Watched {
        inactive: || {
            let connection = ctx.connection();
            connection.closed || connection.sync_terminal_sent
        },
        record: |frame: &Value| progress::record(&mut run.connection(), recording, frame),
        progress: &mut queue,
    };
    let response = progress::await_result(ctx, job, watched)
        .await
        .and_then(Result::ok);
    ctx.connection().continuation = None;
    response
}

/// Runs one continuation of a paused turn under a slot of the Space's chat gate (ADR-0119); Team's answer that the
/// Space is busy puts it back at the head of the queue. `None` means it ended without a result, its terminal sent
/// when it had one to send.
pub async fn gated_continuation(ctx: &Ctx, submit: Submit<'_>) -> Option<Answer> {
    let gate = Arc::clone(&ctx.app.domains.chat.gate);
    let mut held = match gate
        .slot(gated::position(ctx), gated::read_limit(&ctx.team))
        .await
    {
        Ok(held) => held,
        Err(error) => {
            resumed(ctx, &gated::refusal(error), false).await;
            return None;
        }
    };
    loop {
        if let Err(error) = gated::authorized(ctx) {
            resumed(ctx, &gated::refusal(error), false).await;
            return None;
        }
        let (queue, report) = progress::channel();
        let Some(job) = submit(report) else {
            resumed(
                ctx,
                &error_terminal(429, "local chat capacity reached"),
                false,
            )
            .await;
            return None;
        };
        let response = continue_once(ctx, &job, queue).await;
        if !gated::space_busy(response.as_ref()) || ctx.closed() {
            return response;
        }
        if let Err(error) = held.busy().await {
            resumed(ctx, &gated::refusal(error), false).await;
            return None;
        }
    }
}

/// The Integration continuation a granted challenge resumes, under the Space's chat gate.
async fn resumed_integration(ctx: &Ctx, challenge_id: &str) -> Option<Answer> {
    let submit = |report: Progress| {
        let (app, team, team_id) = (
            Arc::clone(&ctx.app),
            ctx.team.clone(),
            ctx.team_id().to_owned(),
        );
        let submission = local_turn::Submission::Integrations {
            challenge_id: challenge_id.to_owned(),
        };
        ctx.app
            .domains
            .chat
            .lanes
            .sync
            .submit(
                async move { local_turn::submit(&app, &team, &team_id, submission, &report).await },
            )
            .ok()
    };
    gated_continuation(ctx, &submit).await
}

async fn load_snapshot(ctx: &Ctx, locale: &str) -> Option<Snapshot> {
    let (team, team_id) = (ctx.team.clone(), ctx.team_id().to_owned());
    let Ok(job) =
        ctx.app
            .domains
            .chat
            .lanes
            .sync
            .submit(snapshot(team, team_id, locale.to_owned()))
    else {
        resumed(
            ctx,
            &error_terminal(429, "local chat capacity reached"),
            false,
        )
        .await;
        return None;
    };
    let mut loaded = match job.wait().await {
        Ended::Done(Ok(snapshot)) => Some(snapshot),
        _ => None,
    };
    if let Some(current) = loaded.clone()
        && let Some(challenge_id) = &current.resume
    {
        loaded = resumed_integration(ctx, challenge_id)
            .await
            .map(|continued| Snapshot {
                continued: Some(continued),
                ..current
            });
    }
    if loaded.is_none() && !ctx.closed() {
        resumed(ctx, &failed(502), false).await;
    }
    loaded
}

/// Restores the Team's paused chat; whether the sync reached an ending of its own.
async fn restore(ctx: &Ctx, locale: &str) -> bool {
    let store = Arc::clone(ctx.history());
    let Ok(pending) = delivery::observe(&store, ctx.team_id()).await else {
        return false;
    };
    ctx.connection().pending_history_id = pending;
    let Some(snapshot) = load_snapshot(ctx, locale).await else {
        return true;
    };
    if ctx.closed() {
        return true;
    }
    if snapshot.kind == "human" {
        sync_delivery::human(ctx, &snapshot.pending).await;
    } else {
        sync_delivery::integration(ctx, &snapshot.pending, snapshot.continued.as_ref()).await;
    }
    true
}

async fn deliver_sync(ctx: Ctx, locale: String, id: u64) {
    let completed = restore(&ctx, &locale).await;
    let unsent = {
        let connection = ctx.connection();
        !connection.closed && !connection.sync_terminal_sent
    };
    if !completed && unsent {
        resumed(&ctx, &failed(502), false).await;
    }
    let mut connection = ctx.connection();
    if connection
        .sync_task
        .as_ref()
        .is_some_and(|task| task.id == id)
    {
        connection.sync_task = None;
    }
}

/// A page's sync frame.
pub fn dispatch_sync(ctx: &Ctx, locale: &str) {
    let mut connection = ctx.connection();
    if connection.sync_task.is_some() || connection.active.is_some() {
        drop(connection);
        ctx.send(&error_terminal(409, "a chat operation is already active"));
        return;
    }
    connection.sync_terminal_sent = false;
    let (task_ctx, locale) = (ctx.clone(), locale.to_owned());
    connection.sync_task = Some(TaskHandle::spawn(move |id| {
        deliver_sync(task_ctx, locale, id)
    }));
}
