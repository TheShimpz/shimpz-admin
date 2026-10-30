//! The Local Supervisor's sign-in: the password, the session token, the second factors, and the journal.

pub mod audit;
pub mod local;
pub mod methods;
pub mod passkeys;
pub mod password;
pub mod recovery;
pub mod routes;
pub mod sessions;
pub mod tickets;
pub mod token;
pub mod totp;

/// Sign-in's process state: the setup lock.
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
