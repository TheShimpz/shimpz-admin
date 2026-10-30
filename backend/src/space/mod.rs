//! The Space's own operations: the platform release status, Space and host reset, and the Supervisor key rotation.

pub mod methods;
pub mod release;
pub mod routes;

/// The Space domain's process state: the key rotation's retry.
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
