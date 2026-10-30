//! Local chat over the session socket (`shimpz.chat.v7`): each Team's run, the Space's chat gate, delivery, and the
//! Assistant lifecycle a message can ask for.

pub mod assets;
pub mod human;
pub mod payloads;

/// Chat's process state: each Team's run, the Space's gate, the catalogs, and the lanes.
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
