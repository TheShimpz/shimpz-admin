//! A Team's Routines (ADR-0086): the scheduler, the machine calls, and the Supervisor's management and answers.

/// The Routines' process state: the scheduler's wake and the open challenges.
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
