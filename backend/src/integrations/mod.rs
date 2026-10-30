//! Assistant Integrations: their projection and the Supervisor's OAuth authorization of one challenge.

pub mod routes;

/// The Integrations' process state: the OAuth handoffs.
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
