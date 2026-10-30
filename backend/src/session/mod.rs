//! The Admin session socket (ADR-0114): its protocol, its topics, and its sockets.

pub mod frames;
pub mod socket;
pub mod topics;

/// The session socket's process state: the registry, the budgets, the lanes, and the watcher.
pub struct State {}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::config::Config,
        _clock: &std::sync::Arc<crate::clock::Clock>,
    ) -> Self {
        Self {}
    }
}
