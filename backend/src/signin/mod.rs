//! The Local Supervisor's sign-in: the password, the session token, the second factors, and the journal.

pub mod audit;
pub mod local;
pub mod methods;
pub mod passkeys;
pub mod password;
pub mod recovery;
pub mod routes;
pub mod security;
pub mod sessions;
pub mod tickets;
pub mod token;
pub mod totp;
pub mod webauthn;

/// Sign-in's process state: the setup lock, and the signing key rotation's lock and retry.
pub struct State {
    /// Setup, its TOTP enrollment, the recovery ceremonies, and a host reset run one at a time.
    pub setup: tokio::sync::Mutex<()>,
    /// One key rotation settles at a time.
    pub rotation: tokio::sync::Mutex<()>,
    /// Wakes the open rotation's retry.
    pub recovery: std::sync::Arc<tokio::sync::Notify>,
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
            rotation: tokio::sync::Mutex::new(()),
            recovery: std::sync::Arc::new(tokio::sync::Notify::new()),
        }
    }
}
