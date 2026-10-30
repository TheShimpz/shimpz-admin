//! The Space's chat execution gate (ADR-0119): at most the Space's limit of chat operations run at once.
//!
//! Team owns the limit and refuses a turn beyond it in the same step that registers the turn, so this gate only shapes
//! the wait: an operation takes a slot before it starts, and the rest wait in one first-in, first-out queue, each told
//! its position as it moves. A Team answer that the Space is still busy puts the operation back at the head of the
//! queue. Stop never waits here: cancelling a waiting operation leaves the queue at once.

use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::{oneshot, watch};

use crate::sync::lock;

/// The operations that may wait at once, across the Space.
pub const MAX_WAITING: usize = 32;
/// How long an operation Team found the Space busy for waits before it asks again.
pub const BUSY_RETRY: Duration = Duration::from_secs(2);

/// Told the operation's place in the queue (1 is next), or `None` once it runs.
pub type Position = Arc<dyn Fn(Option<usize>) + Send + Sync>;

/// Why the gate did not let an operation start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// As many operations as the queue holds already wait.
    QueueFull,
    /// Team did not answer the Space's chat limit.
    LimitUnavailable,
    /// The session the operation was admitted under ended while it waited.
    AuthorityEnded,
}

struct Waiter {
    id: u64,
    position: Position,
    granted: Option<oneshot::Sender<()>>,
    place: Option<usize>,
}

type LimitRead = watch::Receiver<Option<Option<i64>>>;

#[derive(Default)]
struct GateState {
    limit: Option<i64>,
    running: i64,
    waiting: Vec<Waiter>,
    resting: usize,
    reading: usize,
    limit_read: Option<LimitRead>,
    next: u64,
}

/// Positions to tell once the state's lock is released.
type Told = Vec<(Position, Option<usize>)>;

impl GateState {
    fn queued(&self) -> usize {
        self.waiting.len() + self.resting + self.reading
    }

    fn grant(&mut self, told: &mut Told) {
        let limit = self.limit.unwrap_or(0);
        let mut granted = false;
        while !self.waiting.is_empty() && self.running < limit {
            let mut waiter = self.waiting.remove(0);
            self.running += 1;
            if let Some(sender) = waiter.granted.take() {
                let _ = sender.send(());
            }
            granted = true;
        }
        if granted {
            self.tell(told);
        }
    }

    fn tell(&mut self, told: &mut Told) {
        for (index, waiter) in self.waiting.iter_mut().enumerate() {
            let place = index + 1;
            if waiter.place != Some(place) {
                waiter.place = Some(place);
                told.push((Arc::clone(&waiter.position), Some(place)));
            }
        }
    }

    fn release(&mut self, told: &mut Told) {
        self.running -= 1;
        self.grant(told);
    }
}

fn tell(told: Told) {
    for (position, place) in told {
        position(place);
    }
}

/// The Space's chat gate.
#[derive(Default)]
pub struct Gate {
    state: Mutex<GateState>,
}

/// One operation's hold on a slot; dropping it gives the slot back.
pub struct Held {
    gate: Arc<Gate>,
    position: Position,
    holding: bool,
}

/// Leaves the queue, or gives back a slot granted as the wait was dropped.
struct WaitGuard<'a> {
    gate: &'a Gate,
    id: u64,
    armed: bool,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut told = Told::new();
        {
            let mut state = lock(&self.gate.state);
            if let Some(index) = state.waiting.iter().position(|waiter| waiter.id == self.id) {
                state.waiting.remove(index);
                state.tell(&mut told);
            } else {
                state.release(&mut told);
            }
        }
        tell(told);
    }
}

/// Counts an operation that rests after a busy Space against the queue until it queues again; one Stop cut short
/// gives the place it kept to whoever waits.
struct Resting<'a> {
    gate: &'a Gate,
    cut_short: bool,
}

impl Drop for Resting<'_> {
    fn drop(&mut self) {
        let mut told = Told::new();
        {
            let mut state = lock(&self.gate.state);
            state.resting -= 1;
            if self.cut_short {
                state.grant(&mut told);
            }
        }
        tell(told);
    }
}

/// Counts an operation waiting for Team's first answer of the limit.
struct Reading<'a>(&'a Gate);

impl Drop for Reading<'_> {
    fn drop(&mut self) {
        lock(&self.0.state).reading -= 1;
    }
}

impl Gate {
    /// Team's current limit, if it answered.
    #[must_use]
    pub fn limit(&self) -> Option<i64> {
        lock(&self.state).limit
    }

    /// Team answered its current limit: a higher one starts waiting operations; a lower one lets running drain.
    pub fn set_limit(&self, limit: i64) {
        let mut told = Told::new();
        {
            let mut state = lock(&self.state);
            state.limit = Some(limit);
            state.grant(&mut told);
        }
        tell(told);
    }

    /// Holds one slot, waiting for it first, in order, when the Space runs as many as its limit; `read_limit` reads
    /// Team's limit under the waiting operation's own authority when it is not known yet.
    ///
    /// # Errors
    ///
    /// Returns [`Refused`] when the queue is full or the limit is unavailable.
    pub async fn slot<F>(
        self: &Arc<Self>,
        position: Position,
        read_limit: F,
    ) -> Result<Held, Refused>
    where
        F: Future<Output = Option<i64>> + Send + 'static,
    {
        if self.limit().is_none() {
            self.read_limit(read_limit).await?;
        }
        self.acquire(&position, false).await?;
        Ok(Held {
            gate: Arc::clone(self),
            position,
            holding: true,
        })
    }

    async fn read_limit<F>(self: &Arc<Self>, read_limit: F) -> Result<(), Refused>
    where
        F: Future<Output = Option<i64>> + Send + 'static,
    {
        let mut read = {
            let mut state = lock(&self.state);
            if state.queued() >= MAX_WAITING {
                return Err(Refused::QueueFull);
            }
            state.reading += 1;
            if let Some(read) = &state.limit_read {
                read.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.limit_read = Some(receiver.clone());
                let gate = Arc::clone(self);
                tokio::spawn(async move {
                    let answer = read_limit.await;
                    {
                        let mut state = lock(&gate.state);
                        state.limit_read = None;
                        if let (Some(limit), None) = (answer, state.limit) {
                            state.limit = Some(limit);
                        }
                    }
                    let _ = sender.send(Some(answer));
                });
                receiver
            }
        };
        let _reading = Reading(self);
        match read.wait_for(Option::is_some).await.map(|answer| *answer) {
            Ok(Some(Some(_))) => Ok(()),
            _ => Err(Refused::LimitUnavailable),
        }
    }

    async fn acquire(&self, position: &Position, head: bool) -> Result<(), Refused> {
        let mut told = Told::new();
        let (id, receiver) = {
            let mut state = lock(&self.state);
            let limit = state.limit.unwrap_or(0);
            if state.waiting.is_empty() && (state.resting == 0 || head) && state.running < limit {
                state.running += 1;
                drop(state);
                position(None);
                return Ok(());
            }
            if !head && state.queued() >= MAX_WAITING {
                return Err(Refused::QueueFull);
            }
            let (sender, receiver) = oneshot::channel();
            state.next += 1;
            let id = state.next;
            let waiter = Waiter {
                id,
                position: Arc::clone(position),
                granted: Some(sender),
                place: None,
            };
            if head {
                state.waiting.insert(0, waiter);
            } else {
                state.waiting.push(waiter);
            }
            if state.resting == 0 {
                state.grant(&mut told);
            }
            state.tell(&mut told);
            (id, receiver)
        };
        tell(told);
        let mut guard = WaitGuard {
            gate: self,
            id,
            armed: true,
        };
        let granted = receiver.await;
        guard.armed = false;
        if granted.is_err() {
            return Err(Refused::QueueFull);
        }
        position(None);
        Ok(())
    }
}

impl Held {
    /// Team found the Space busy: gives the slot back, waits a moment, and takes one again at the head of the queue;
    /// while it rests it still counts against the queue's bound.
    ///
    /// # Errors
    ///
    /// Returns [`Refused`] when the slot cannot be taken again.
    pub async fn busy(&mut self) -> Result<(), Refused> {
        self.release();
        lock(&self.gate.state).resting += 1;
        {
            let mut resting = Resting {
                gate: &self.gate,
                cut_short: true,
            };
            tokio::time::sleep(BUSY_RETRY).await;
            resting.cut_short = false;
        }
        self.gate.acquire(&self.position, true).await?;
        self.holding = true;
        Ok(())
    }

    /// Gives the slot back once.
    pub fn release(&mut self) {
        if !self.holding {
            return;
        }
        self.holding = false;
        let mut told = Told::new();
        lock(&self.gate.state).release(&mut told);
        tell(told);
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests;
