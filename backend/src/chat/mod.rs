//! Local chat over the session socket (`shimpz.chat.v7`): each Team's run, the Space's chat gate, delivery, and the
//! Assistant lifecycle a message can ask for.

pub mod assets;
pub mod assistant_install;
pub mod assistant_proposal;
pub mod human;
pub mod local;
pub mod methods;
pub mod payloads;
pub mod projection;
pub mod run;

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
