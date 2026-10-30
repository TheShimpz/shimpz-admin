//! The Space's own operations: the platform release status, Space and host reset, and the Supervisor key rotation.

pub mod host_reset;
pub mod keys;
pub mod methods;
pub mod release;
pub mod reset;
pub mod routes;
pub mod supervisor_key;

/// The Space domain's process state.
pub struct State {
    /// Held by the Supervisor's setup and by a host reset: neither runs while the other does.
    pub setup: tokio::sync::Mutex<()>,
}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::process::config::Config,
        _clock: &std::sync::Arc<crate::time::clock::Clock>,
    ) -> Self {
        Self {
            setup: tokio::sync::Mutex::new(()),
        }
    }
}
