//! Ordered progress delivery for chat: each started job reports its public progress into a bounded queue, which its
//! delivery hands to the run's pages in order before the job's own result.

use std::sync::Arc;

use tokio::sync::mpsc;

use super::super::{
    connection::Connection,
    local::{MAX_PUBLIC_PROGRESS_EVENTS, canonical_public_progress, turn::Progress},
    socket::Ctx,
};
use crate::{
    json::{self, Value},
    lanes::{Ended, Job},
};

/// The receiving end of one job's progress.
pub type ProgressQueue = mpsc::Receiver<Value>;

/// One bounded queue and the reporter a job hands its progress to; progress beyond the bound is dropped.
#[must_use]
pub fn channel() -> (ProgressQueue, Progress) {
    let (sender, receiver) = mpsc::channel(MAX_PUBLIC_PROGRESS_EVENTS);
    let report: Progress = Arc::new(move |event: Value| {
        if let Ok(event) = canonical_public_progress(&event) {
            let _ = sender.try_send(event);
        }
    });
    (receiver, report)
}

/// Where one delivery's progress is recorded: the receipt collection and the delivery's number within it.
#[derive(Clone, Copy, Debug)]
pub struct Recording {
    generation: u64,
    delivery: i64,
}

fn begin_collection(connection: &mut Connection, turn_id: Option<&str>) {
    connection.receipt.turn_id = turn_id.map(str::to_owned);
    connection.receipt.deliveries = 0;
    connection.receipt.events.clear();
    connection.receipt.generation += 1;
}

/// Begins one progress delivery of `turn_id`'s receipt: a Team turn's own delivery begins it afresh; a continuation
/// adds to the receipt of the same history turn, and one of another turn begins its own.
pub fn receipt_delivery(
    connection: &mut Connection,
    turn_id: Option<&str>,
    fresh: bool,
) -> Recording {
    if fresh || connection.receipt.turn_id.as_deref() != turn_id {
        begin_collection(connection, turn_id);
    }
    let delivery = connection.receipt.deliveries;
    connection.receipt.deliveries += 1;
    Recording {
        generation: connection.receipt.generation,
        delivery,
    }
}

/// Records one delivered progress frame: Admin's own steps never enter a receipt, and one more than the bound is kept
/// so a receipt that outgrew it is known and left out.
pub fn record(connection: &mut Connection, recording: Recording, frame: &Value) {
    let receipt = &mut connection.receipt;
    if receipt.generation != recording.generation
        || json::get_str(frame, "origin") != Some("team")
        || receipt.events.len() > MAX_PUBLIC_PROGRESS_EVENTS
    {
        return;
    }
    let mut members = vec![("segment".to_owned(), json::int(recording.delivery))];
    members.extend(
        json::members(&json::without(frame, "type"))
            .unwrap_or_default()
            .iter()
            .cloned(),
    );
    receipt.events.push(Value::Object(members));
}

/// Ends the logical turn's receipt and returns it for `turn_id`'s reply, its deliveries renumbered in order from 0;
/// none of another turn, an empty one, or one that outgrew its bound.
pub fn take_receipt(connection: &mut Connection, turn_id: Option<&str>) -> Option<Value> {
    let owner = connection.receipt.turn_id.clone();
    let events = std::mem::take(&mut connection.receipt.events);
    begin_collection(connection, None);
    let turn_id = turn_id?;
    if owner.as_deref() != Some(turn_id)
        || events.is_empty()
        || events.len() > MAX_PUBLIC_PROGRESS_EVENTS
    {
        return None;
    }
    let mut numbers: Vec<i64> = Vec::new();
    let renumbered = events
        .into_iter()
        .map(|mut event| {
            let segment = json::get(&event, "segment")
                .and_then(json::as_int)
                .unwrap_or_default();
            let number = numbers
                .iter()
                .position(|known| *known == segment)
                .unwrap_or_else(|| {
                    numbers.push(segment);
                    numbers.len() - 1
                });
            json::set(
                &mut event,
                "segment",
                json::int(i64::try_from(number).unwrap_or(i64::MAX)),
            );
            event
        })
        .collect();
    Some(Value::Array(renumbered))
}

/// What one awaited delivery watches.
pub struct Watched<'a, I, R>
where
    I: Fn() -> bool,
    R: Fn(&Value),
{
    /// Whether the delivery no longer matters (its run closed or its terminal went out).
    pub inactive: I,
    /// Records each delivered frame.
    pub record: R,
    /// The job's progress.
    pub progress: &'a mut ProgressQueue,
}

fn frame(sequence: i64, event: &Value) -> Value {
    let mut members = vec![
        ("type".to_owned(), json::text("progress")),
        ("seq".to_owned(), json::int(sequence)),
    ];
    members.extend(json::members(event).unwrap_or_default().iter().cloned());
    Value::Object(members)
}

/// Hands each progress event to the run's pages in sequence while the delivery still matters.
struct Sender<'c, I, R> {
    ctx: &'c Ctx,
    inactive: I,
    record: R,
    sequence: i64,
}

impl<I: Fn() -> bool, R: Fn(&Value)> Sender<'_, I, R> {
    fn deliver(&mut self, event: &Value) -> bool {
        if (self.inactive)() {
            return false;
        }
        self.sequence += 1;
        let frame = frame(self.sequence, event);
        self.ctx.relay.send(&frame);
        (self.record)(&frame);
        true
    }
}

/// The job's end, its progress delivered as it comes; `None` once the delivery no longer matters.
async fn until_ended<T, I, R>(
    job: &Job<T>,
    queue: &mut ProgressQueue,
    sender: &mut Sender<'_, I, R>,
) -> Option<Ended<T>>
where
    T: Clone,
    I: Fn() -> bool,
    R: Fn(&Value),
{
    loop {
        let event = tokio::select! {
            biased;
            event = queue.recv() => event,
            ended = job.wait() => return Some(ended),
        };
        match event {
            Some(event) if !sender.deliver(&event) => return None,
            Some(_) => {}
            None => return Some(job.wait().await),
        }
    }
}

/// Delivers a job's ordered progress before returning its result; `None` once the delivery no longer matters or the
/// job ended without a result.
pub async fn await_result<T, I, R>(ctx: &Ctx, job: &Job<T>, watched: Watched<'_, I, R>) -> Option<T>
where
    T: Clone,
    I: Fn() -> bool,
    R: Fn(&Value),
{
    let mut sender = Sender {
        ctx,
        inactive: watched.inactive,
        record: watched.record,
        sequence: 0,
    };
    let ended = until_ended(job, watched.progress, &mut sender).await?;
    while let Ok(event) = watched.progress.try_recv() {
        if !sender.deliver(&event) {
            return None;
        }
    }
    if (sender.inactive)() {
        return None;
    }
    match ended {
        Ended::Done(result) => Some(result),
        Ended::Cancelled | Ended::Panicked => None,
    }
}
