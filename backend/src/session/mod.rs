//! The Admin session socket (ADR-0114): its protocol, its topics, and its sockets.

pub mod budget;
pub mod calls;
pub mod frames;
pub mod methods;
pub mod outbound;
pub mod registry;
pub mod socket;
pub mod stepup;
pub mod topics;
pub mod watcher;

/// The session socket's process state: the registry, the budgets, the lanes, and the watcher.
pub struct State {
    /// The open sockets.
    pub registry: registry::Registry,
    /// The session budgets.
    pub budgets: budget::Budgets,
    /// The call lanes.
    pub lanes: calls::Lanes,
    /// The watcher.
    pub watcher: watcher::Watcher,
}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::config::Config,
        clock: &std::sync::Arc<crate::clock::Clock>,
    ) -> Self {
        Self {
            registry: registry::Registry::default(),
            budgets: budget::Budgets::new(clock),
            lanes: calls::Lanes::default(),
            watcher: watcher::Watcher::default(),
        }
    }
}
