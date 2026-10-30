//! The Space's own operations: the platform release status, Space and host reset, and the Supervisor key rotation.

pub mod host_reset;
pub mod keys;
pub mod methods;
pub mod release;
pub mod reset;
pub mod routes;
pub mod supervisor_key;

/// The Space domain's process state (a host reset holds sign-in's setup lock, `signin::State::setup`).
pub struct State {}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::process::config::Config,
        _clock: &std::sync::Arc<crate::time::clock::Clock>,
    ) -> Self {
        Self {}
    }
}
