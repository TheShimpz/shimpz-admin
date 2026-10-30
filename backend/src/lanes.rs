//! Bounded worker lanes: at most `workers` jobs of a lane run at once and at most `outstanding` are admitted; a full
//! lane refuses at once rather than queue without bound.
//!
//! A submitted job is detached: it runs to its end whatever happens to whoever submitted it, and its result is kept for
//! anyone still waiting. A job can be cancelled only while it waits for a worker; once it runs, it finishes.

use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use futures_util::FutureExt;
use tokio::sync::{Semaphore, watch};

const PENDING: u8 = 0;
const RUNNING: u8 = 1;
const CANCELLED: u8 = 2;

/// The lane has no free admission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Saturated;

/// How a job ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Ended<T> {
    /// It ran to its end with this result.
    Done(T),
    /// It was cancelled before it started.
    Cancelled,
    /// It panicked; its payload was never printed.
    Panicked,
}

/// One bounded lane.
#[derive(Clone)]
pub struct Lane {
    workers: Arc<Semaphore>,
    admitted: Arc<Semaphore>,
}

/// One submitted job: its result for every waiter, and its cancellation while it waits for a worker.
pub struct Job<T> {
    state: Arc<AtomicU8>,
    result: watch::Receiver<Option<Ended<T>>>,
}

impl<T> Clone for Job<T> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
            result: self.result.clone(),
        }
    }
}

impl Lane {
    /// A lane of `workers` running jobs and `outstanding` admitted ones (`outstanding >= workers >= 1`).
    #[must_use]
    pub fn new(workers: usize, outstanding: usize) -> Self {
        Self {
            workers: Arc::new(Semaphore::new(workers.max(1))),
            admitted: Arc::new(Semaphore::new(outstanding.max(workers).max(1))),
        }
    }

    /// Admits `job` now, or refuses at once when the lane is full.
    ///
    /// # Errors
    ///
    /// Returns [`Saturated`] when every admission is taken.
    pub fn submit<F, T>(&self, job: F) -> Result<Job<T>, Saturated>
    where
        F: Future<Output = T> + Send + 'static,
        T: Clone + Send + Sync + 'static,
    {
        let admitted = Arc::clone(&self.admitted)
            .try_acquire_owned()
            .map_err(|_| Saturated)?;
        let workers = Arc::clone(&self.workers);
        let state = Arc::new(AtomicU8::new(PENDING));
        let (sender, receiver) = watch::channel(None);
        let task_state = Arc::clone(&state);
        tokio::spawn(async move {
            let _admitted = admitted;
            let Ok(_worker) = workers.acquire_owned().await else {
                let _ = sender.send(Some(Ended::Cancelled));
                return;
            };
            if task_state
                .compare_exchange(PENDING, RUNNING, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                let _ = sender.send(Some(Ended::Cancelled));
                return;
            }
            let ended = match std::panic::AssertUnwindSafe(job).catch_unwind().await {
                Ok(result) => Ended::Done(result),
                Err(_) => Ended::Panicked,
            };
            let _ = sender.send(Some(ended));
        });
        Ok(Job {
            state,
            result: receiver,
        })
    }
}

impl<T: Clone> Job<T> {
    /// Cancels the job if it has not started; `true` when it never will.
    #[must_use]
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(PENDING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
            || self.state.load(Ordering::SeqCst) == CANCELLED
    }

    /// Whether the job ended.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.result.borrow().is_some()
    }

    /// Waits for the job's end.
    pub async fn wait(&self) -> Ended<T> {
        let mut receiver = self.result.clone();
        match receiver.wait_for(Option::is_some).await {
            Ok(ended) => ended.clone().unwrap_or(Ended::Cancelled),
            Err(_) => Ended::Panicked,
        }
    }
}

/// Runs `job` detached: it runs to its end whatever happens to the caller, which may stop waiting for it.
pub fn detach<F, T>(job: F) -> Job<T>
where
    F: Future<Output = T> + Send + 'static,
    T: Clone + Send + Sync + 'static,
{
    Lane::new(1, 1)
        .submit(job)
        .unwrap_or_else(|_| unreachable!("a fresh lane admits its first job"))
}

#[cfg(test)]
mod tests;
