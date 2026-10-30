//! A Team's Routines (ADR-0086): the scheduler, the machine calls, and the Supervisor's management and answers.

pub mod answer;
pub mod delivery;
pub mod history;
pub mod manage;
pub mod methods;
pub mod scheduler;
pub mod team;

/// The Routines' process state: the scheduler's wake and the open challenges.
pub struct State {
    /// The scheduler.
    pub scheduler: scheduler::Scheduler,
    /// The challenges of frozen runs Admin opened.
    pub challenges: answer::Challenges,
}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::config::Config,
        clock: &std::sync::Arc<crate::clock::Clock>,
    ) -> Self {
        Self {
            scheduler: scheduler::Scheduler::new(clock.now_ms()),
            challenges: answer::Challenges::new(std::sync::Arc::clone(clock)),
        }
    }
}
