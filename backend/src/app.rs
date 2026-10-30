//! One Admin process: its configuration and every authority its routes, sockets, and background tasks share.

use std::sync::Arc;

use crate::{
    chat::human::ActionPasswords,
    clock::Clock,
    config::Config,
    fault::Fault,
    outbound,
    record::{StateError, Store},
    session::{frames::SourceBuild, topics::Topics},
    signin::{
        audit::Audit, passkeys::Challenges, password::LoginLimiter, sessions::Sessions,
        tickets::Tickets, token,
    },
    supervisor::assertion::AuthorityKind,
    team::transport::{Scope, Team, TeamClient},
};

/// Everything one Admin process shares.
pub struct App {
    /// The configuration it started with.
    pub config: Config,
    /// Its clocks.
    pub clock: Arc<Clock>,
    /// The session socket's invalidation topics.
    pub topics: Arc<Topics>,
    /// The sessions this process issued.
    pub sessions: Arc<Sessions>,
    /// `admin.json`.
    pub store: Arc<Store>,
    /// The authentication journal.
    pub audit: Arc<Audit>,
    /// Sign-in's one-derivation limiter and lockout.
    pub limiter: Arc<LoginLimiter>,
    /// The one-use password tickets.
    pub tickets: Tickets,
    /// The passkey challenges.
    pub challenges: Challenges,
    /// The Action password authority chat and frozen Routine runs share.
    pub action_passwords: ActionPasswords,
    /// Team.
    pub team_client: Arc<TeamClient>,
    /// Outbound HTTPS to the Store and the providers.
    pub outbound: outbound::Client,
    /// The commit this Admin was built from.
    pub source: Option<SourceBuild>,
    /// The compiled Admin UI.
    pub site: crate::http::statics::Site,
    /// The domains' own state.
    pub domains: crate::domains::Domains,
}

/// The session cookie.
pub const COOKIE: &str = "shimpz_admin";

impl App {
    /// A process configured by `config`.
    #[must_use]
    pub fn new(config: Config) -> Arc<Self> {
        let clock = Arc::new(Clock::new());
        Self::with_clock(config, clock)
    }

    /// A process configured by `config` reading `clock` (tests move it).
    #[must_use]
    pub fn with_clock(config: Config, clock: Arc<Clock>) -> Arc<Self> {
        let topics = Arc::new(Topics::new());
        let sessions = Arc::new(Sessions::new(Arc::clone(&clock)));
        let store = Arc::new(Store::new(
            config.store_path.clone(),
            Arc::clone(&clock),
            Arc::clone(&sessions),
            Arc::clone(&topics),
        ));
        let audit = Arc::new(Audit::new(
            config.audit_path(),
            Arc::clone(&topics),
            Arc::clone(&clock),
        ));
        let team_client = Arc::new(TeamClient::new(
            &config.team_url,
            config.team_token_file.clone(),
            Arc::clone(&clock),
        ));
        let source = read_source(&config.revision_file).ok().flatten();
        let site = crate::http::statics::Site::index(&config.ui_dir);
        let domains = crate::domains::Domains::new(&config, &clock);
        let app = Arc::new(Self {
            limiter: Arc::new(LoginLimiter::new(Arc::clone(&clock))),
            tickets: Tickets::new(Arc::clone(&clock)),
            challenges: Challenges::new(Arc::clone(&clock)),
            action_passwords: ActionPasswords::new(Arc::clone(&store), Arc::clone(&clock)),
            outbound: outbound::Client::new(config.outbound.clone()),
            config,
            clock,
            topics,
            sessions,
            store,
            audit,
            team_client,
            source,
            site,
            domains,
        });
        let weak = Arc::downgrade(&app);
        app.sessions.listen(Arc::new(move |ended| {
            if let Some(app) = weak.upgrade() {
                app.domains.session.registry.end_sessions(ended);
            }
        }));
        app
    }

    /// Team with the bearer alone.
    #[must_use]
    pub fn machine_team(&self) -> Team {
        Team::machine(Arc::clone(&self.team_client))
    }

    /// Team under a Supervisor session's authority, bound again from the current signing identity.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::Authority`] when the identity is unavailable, or [`Fault::TeamRequest`] for a cookie value
    /// outside the assertion's grammar.
    pub fn session_team(&self, cookie: &str) -> Result<Team, Fault> {
        self.scoped_team(cookie, AuthorityKind::Session)
    }

    /// Team under `value` of `kind`, bound to the current signing identity.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::Authority`] or [`Fault::TeamRequest`].
    pub fn scoped_team(&self, value: &str, kind: AuthorityKind) -> Result<Team, Fault> {
        let identity = self.store.local_supervisor().map_err(|_| {
            Fault::TeamRequest("Local Supervisor identity is unavailable".to_owned())
        })?;
        Ok(Team::scoped(
            Arc::clone(&self.team_client),
            Scope::new(value, identity, kind)?,
        ))
    }

    /// The admitted browser origins: the static ones and the learned external origin, if any.
    ///
    /// # Errors
    ///
    /// Returns the store's error when the learned origin cannot be read.
    pub fn allowed_origins(&self) -> Result<Vec<String>, StateError> {
        let mut origins = self.config.static_origins.clone();
        if let Some(origin) = self.store.browser_origin()? {
            origins.push(origin);
        }
        origins.sort();
        origins.dedup();
        Ok(origins)
    }

    /// The admitted origins, or only the static ones when the learned origin cannot be read.
    #[must_use]
    pub fn socket_origins(&self) -> Vec<String> {
        self.allowed_origins()
            .unwrap_or_else(|_| self.config.static_origins.clone())
    }

    /// The session's signed evidence when it is current (never renewing it unless `activity`).
    ///
    /// # Errors
    ///
    /// Returns a store error, or [`StateError::PasswordRecord`] for a record that needs recovery.
    pub fn session_evidence(
        &self,
        cookie: &str,
        activity: bool,
    ) -> Result<Option<token::Evidence>, StateError> {
        if self.store.authentication_state()? != crate::record::AuthState::Configured {
            return Ok(None);
        }
        let secret = self.store.session_secret()?;
        let evidence = token::verify(&self.sessions, &self.clock, &secret, cookie, activity);
        if evidence.is_some() {
            self.store
                .local_supervisor()
                .map_err(|_| StateError::Authority)?;
        }
        Ok(evidence)
    }
}

/// The Admin source revision file is malformed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MalformedSource;

/// This Admin's build commit and commit time, or `None` without a build (a working tree or a test).
///
/// # Errors
///
/// Returns [`MalformedSource`] for a malformed file, which fails Admin's start.
pub fn read_source(path: &std::path::Path) -> Result<Option<SourceBuild>, MalformedSource> {
    let content = match std::fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(MalformedSource),
    };
    let text = std::str::from_utf8(&content)
        .map_err(|_| MalformedSource)?
        .strip_suffix('\n')
        .ok_or(MalformedSource)?;
    let (revision, time) = text.split_once(' ').ok_or(MalformedSource)?;
    if time.is_empty()
        || time.len() > 12
        || time.starts_with('0')
        || !time.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(MalformedSource);
    }
    SourceBuild::admitted(revision, time.parse().map_err(|_| MalformedSource)?)
        .map(Some)
        .ok_or(MalformedSource)
}
