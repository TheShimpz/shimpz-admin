//! Each domain's own process state, held by the [`crate::app::App`] every route and task shares.

use std::sync::Arc;

use crate::{clock::Clock, config::Config};

/// The domains' state.
pub struct Domains {
    /// The chat history.
    pub history: crate::history::State,
    /// Chat.
    pub chat: crate::chat::State,
    /// The Team domain.
    pub team: crate::team::State,
    /// Integrations.
    pub integrations: crate::integrations::State,
    /// Routines.
    pub routines: crate::routine::State,
    /// The Space's own operations.
    pub space: crate::space::State,
    /// The session socket.
    pub session: crate::session::State,
    /// Sign-in.
    pub signin: crate::signin::State,
}

impl Domains {
    /// Every domain at start.
    #[must_use]
    pub fn new(config: &Config, clock: &Arc<Clock>) -> Self {
        Self {
            history: crate::history::State::new(config, clock),
            chat: crate::chat::State::new(config, clock),
            team: crate::team::State::new(config, clock),
            integrations: crate::integrations::State::new(config, clock),
            routines: crate::routine::State::new(config, clock),
            space: crate::space::State::new(config, clock),
            session: crate::session::State::new(config, clock),
            signin: crate::signin::State::new(config, clock),
        }
    }
}
