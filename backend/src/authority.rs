//! The Supervisor authority work admitted on a session socket keeps after the socket closes (ADR-0119): the session it
//! was admitted under and the Origin of the page that asked, checked again by the full rule and never renewed.

use std::sync::{Arc, Weak};

use zeroize::Zeroizing;

use crate::{app::App, fault::Fault, signin::sessions::session_key, team::transport::Team};

/// Whether a session is current: `active`, `invalid`, or `unavailable` when the check itself failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    /// Current.
    Active,
    /// Expired, idle, revoked, or never issued.
    Invalid,
    /// The check could not be answered.
    Unavailable,
}

/// The current status of the session `cookie` names, never renewing it.
#[must_use]
pub fn session_status(app: &App, cookie: &str, activity: bool) -> SessionStatus {
    match app.session_evidence(cookie, activity) {
        Ok(Some(_)) => SessionStatus::Active,
        Ok(None) => SessionStatus::Invalid,
        Err(_) => SessionStatus::Unavailable,
    }
}

/// One admitted authority: its session and the Origin it was admitted from.
#[derive(Clone)]
pub struct Authority {
    /// The session's digest.
    pub session: String,
    cookie: Arc<Zeroizing<String>>,
    origin: String,
    app: Weak<App>,
}

impl std::fmt::Debug for Authority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Authority")
            .field("session", &self.session)
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

impl Authority {
    /// The authority of the session `cookie` names, admitted from `origin`.
    #[must_use]
    pub fn new(app: &Arc<App>, cookie: &str, origin: &str) -> Self {
        Self {
            session: session_key(cookie),
            cookie: Arc::new(Zeroizing::new(cookie.to_owned())),
            origin: origin.to_owned(),
            app: Arc::downgrade(app),
        }
    }

    /// The Admin process, while it runs.
    #[must_use]
    pub fn app(&self) -> Option<Arc<App>> {
        self.app.upgrade()
    }

    /// The Origin it was admitted from.
    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// The session cookie.
    #[must_use]
    pub fn cookie(&self) -> &str {
        &self.cookie
    }

    /// Team under this authority, bound again from the current signing identity.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::Authority`] when it is unavailable.
    pub fn team(&self) -> Result<Team, Fault> {
        let app = self.app().ok_or(Fault::Authority)?;
        app.session_team(&self.cookie)
    }

    /// Whether the same Origin is still admitted and the same session still current by the full rule, never renewing
    /// it.
    #[must_use]
    pub fn current(&self) -> bool {
        let Some(app) = self.app() else {
            return false;
        };
        let admitted = app
            .allowed_origins()
            .is_ok_and(|origins| origins.contains(&self.origin));
        admitted && session_status(&app, &self.cookie, false) == SessionStatus::Active
    }
}
