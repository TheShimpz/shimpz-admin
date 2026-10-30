//! Admin's bounded bridge to the Local Team.

pub mod assets;
pub mod bridge;
pub mod browser_view;
pub mod files;
pub mod history;
pub mod methods;
pub mod names;
pub mod order;
pub mod sign_ins;
pub mod stored_input;
pub mod summary;
pub mod transport;

/// The Team domain's process state.
pub struct State {
    /// Serializes a reorder with Team creation, deletion, and Space reset.
    pub order: tokio::sync::Mutex<()>,
    /// The chat history's lifecycle lock Team lifecycle holds (see [`history`]).
    pub lifecycle: tokio::sync::Mutex<()>,
    /// The file originals held for sending at once.
    pub downloads: std::sync::Arc<tokio::sync::Semaphore>,
    /// The Browser view streams relayed at once.
    pub streams: std::sync::Arc<tokio::sync::Semaphore>,
    /// The running and starting sign-in sessions.
    pub sign_ins: sign_ins::Tracker,
}

impl State {
    /// The domain's state at start.
    #[must_use]
    pub fn new(
        _config: &crate::process::config::Config,
        _clock: &std::sync::Arc<crate::time::clock::Clock>,
    ) -> Self {
        Self {
            order: tokio::sync::Mutex::new(()),
            lifecycle: tokio::sync::Mutex::new(()),
            downloads: std::sync::Arc::new(tokio::sync::Semaphore::new(files::MAX_DOWNLOADS)),
            streams: std::sync::Arc::new(tokio::sync::Semaphore::new(browser_view::MAX_STREAMS)),
            sign_ins: sign_ins::Tracker::default(),
        }
    }
}
