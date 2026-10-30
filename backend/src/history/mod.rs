//! The durable Local chat history (`chat-history.sqlite3`, schema 15) and its bounded conversation projection.

pub mod context;
pub mod delivery;
pub mod http;
pub mod lifecycle;
pub mod reply;
pub mod store;

use std::sync::Arc;

use crate::{lanes::Lane, process::config::Config, session::topics::Topics, time::clock::Clock};

/// A value outside the history's closed shapes (Python's `ValueError`), with its reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

/// Why a history operation did not complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryError {
    /// A value outside the closed shapes.
    Invalid(&'static str),
    /// The private transcript cannot be read or committed safely.
    Unavailable,
}

impl From<Invalid> for HistoryError {
    fn from(Invalid(reason): Invalid) -> Self {
        Self::Invalid(reason)
    }
}

/// The history store's process state.
pub struct State {
    /// The transcript.
    pub store: Arc<store::Store>,
    /// The lane a user message's admission runs on: one worker, a few waiting.
    pub admission: Lane,
}

impl State {
    /// The store at the configured path.
    #[must_use]
    pub fn new(config: &Config, clock: &Arc<Clock>, topics: &Arc<Topics>) -> Self {
        Self {
            store: Arc::new(store::Store::new(
                config.history_path(),
                Arc::clone(clock),
                Arc::clone(topics),
            )),
            admission: Lane::new(1, 4),
        }
    }
}
