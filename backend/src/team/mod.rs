//! Admin's bounded bridge to the Local Team.

pub mod assets;
pub mod bridge;
pub mod browser_view;
pub mod files;
pub mod methods;
pub mod order;
pub mod transport;

/// The Team domain's process state: the Team order lock, sign-in sessions, and bounded streams.
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
