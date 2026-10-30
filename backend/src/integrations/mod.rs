//! Assistant Integrations: their projection and the Supervisor's OAuth authorization of one challenge.

pub mod assistants;
pub mod authorization;
pub mod cloudflare;
pub mod handoff;
pub mod routes;

use std::sync::Arc;

use crate::{process::config::Config, time::clock::Clock};

/// The Integrations' process state: the OAuth handoffs.
pub struct State {
    /// The one-use OAuth browser handoffs.
    pub handoffs: handoff::Handoffs,
}

impl State {
    /// No handoff yet.
    #[must_use]
    pub fn new(_config: &Config, clock: &Arc<Clock>) -> Self {
        Self {
            handoffs: handoff::Handoffs::new(Arc::clone(clock)),
        }
    }
}
