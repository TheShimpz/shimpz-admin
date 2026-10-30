//! What one Admin process is configured with, read once at start.
//!
//! Compose sets only the admitted browser origins and the Space id; every path is the image's own. A test builds a
//! [`Config`] directly, with its own directories and endpoints.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use team_protocol::websocket::canonical_origin;

/// The exact browser origins Compose admits, comma-separated.
const ALLOWED_ORIGINS: &str = "SHIMPZ_ADMIN_ALLOWED_ORIGINS";
/// The Space's identity, which binds the host reset capability.
const SPACE_ID: &str = "SHIMPZ_SPACE_ID";
/// The loopback origins the CLI-emitted Compose admits when it names none.
pub const DEFAULT_ORIGINS: &str = "http://127.0.0.1:7777,http://localhost:7777";

/// Where Admin's outbound HTTPS requests (the Store catalog and provider key probes) go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outbound {
    /// The named hosts on port 443 over TLS, verified against the system roots.
    Internet,
    /// Every request in plain HTTP to one local test server, its host kept in the `Host` header (tests only).
    Local(SocketAddr),
}

/// One Admin process's configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// The address the HTTP server listens on.
    pub listen: SocketAddr,
    /// The exact static browser origins Admin admits.
    pub static_origins: Vec<String>,
    /// The Space id the host reset capability must name (`space-` and 24 hex digits), when configured.
    pub space_id: String,
    /// Team's base URL (`http://host:port`).
    pub team_url: String,
    /// The file Team writes its bearer to.
    pub team_token_file: PathBuf,
    /// `admin.json`; `audit.jsonl` and the chat history live beside it.
    pub store_path: PathBuf,
    /// `team-order.json`.
    pub team_order_path: PathBuf,
    /// The Supervisor's published verification key; the Routine key is `routine.pem` beside it.
    pub public_key_file: PathBuf,
    /// The group that may read the published keys.
    pub key_group: u32,
    /// The platform release status the CLI projects.
    pub release_status_path: PathBuf,
    /// The host reset capability the CLI projects.
    pub reset_capability_path: PathBuf,
    /// The compiled Admin UI.
    pub ui_dir: PathBuf,
    /// The commit the image was built from and its commit time.
    pub revision_file: PathBuf,
    /// Where outbound HTTPS requests go.
    pub outbound: Outbound,
}

/// The configuration refused at start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// `SHIMPZ_ADMIN_ALLOWED_ORIGINS` is not a list of exact HTTP(S) origins.
    Origins,
    /// A numeric setting is not a number.
    Number,
}

impl Config {
    /// The production configuration: the image's paths and the environment Compose sets.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] for a setting Admin cannot run with.
    pub fn from_env() -> Result<Self, ConfigError> {
        let variable = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let origins = std::env::var(ALLOWED_ORIGINS).unwrap_or_else(|_| DEFAULT_ORIGINS.to_owned());
        let public_key_file = variable("SHIMPZ_LOCAL_SUPERVISOR_PUBLIC_KEY_FILE").map_or_else(
            || PathBuf::from("/run/shimpz-local-supervisor/public.pem"),
            PathBuf::from,
        );
        let key_group = match variable("SHIMPZ_LOCAL_SUPERVISOR_KEY_GID") {
            Some(value) => value.parse().map_err(|_| ConfigError::Number)?,
            None => 10021,
        };
        Ok(Self {
            listen: SocketAddr::from(([0, 0, 0, 0], 4600)),
            static_origins: static_origins(&origins)?,
            space_id: std::env::var(SPACE_ID).unwrap_or_default(),
            team_url: variable("SHIMPZ_TEAM_URL").unwrap_or_else(|| "http://team:7077".to_owned()),
            team_token_file: variable("SHIMPZ_TEAM_TOKEN_FILE")
                .map_or_else(|| PathBuf::from("/run/shimpz-local/token"), PathBuf::from),
            store_path: variable("SHIMPZ_ADMIN_STORE")
                .map_or_else(|| PathBuf::from("/data/admin.json"), PathBuf::from),
            team_order_path: variable("SHIMPZ_TEAM_ORDER_STORE")
                .map_or_else(|| PathBuf::from("/data/team-order.json"), PathBuf::from),
            public_key_file,
            key_group,
            release_status_path: PathBuf::from("/run/shimpz-local-release/status.json"),
            reset_capability_path: PathBuf::from("/run/shimpz-local-reset/capability.json"),
            ui_dir: PathBuf::from("/app/frontend/build"),
            revision_file: PathBuf::from("/app/revision"),
            outbound: Outbound::Internet,
        })
    }

    /// A configuration whose every file lives under `root`, for tests and local runs.
    #[must_use]
    pub fn under(root: &Path) -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 0)),
            static_origins: DEFAULT_ORIGINS.split(',').map(str::to_owned).collect(),
            space_id: "space-0123456789abcdef01234567".to_owned(),
            team_url: "http://127.0.0.1:9".to_owned(),
            team_token_file: root.join("run/token"),
            store_path: root.join("data/admin.json"),
            team_order_path: root.join("data/team-order.json"),
            public_key_file: root.join("supervisor/public.pem"),
            key_group: crate::fsio::egid(),
            release_status_path: root.join("release/status.json"),
            reset_capability_path: root.join("reset/capability.json"),
            ui_dir: root.join("ui"),
            revision_file: root.join("revision"),
            outbound: Outbound::Local(SocketAddr::from(([127, 0, 0, 1], 9))),
        }
    }

    /// The authentication journal beside `admin.json`.
    #[must_use]
    pub fn audit_path(&self) -> PathBuf {
        self.store_path.with_file_name("audit.jsonl")
    }

    /// The chat history beside `admin.json`.
    #[must_use]
    pub fn history_path(&self) -> PathBuf {
        self.store_path.with_file_name("chat-history.sqlite3")
    }

    /// The Routine identity's published verification key, beside the Supervisor's.
    #[must_use]
    pub fn routine_key_file(&self) -> PathBuf {
        self.public_key_file.with_file_name("routine.pem")
    }
}

/// The exact first-party origins a comma-separated setting names; anything else refuses to start.
///
/// # Errors
///
/// Returns [`ConfigError::Origins`] for an empty list or one item that is not exactly a canonical origin.
pub fn static_origins(configured: &str) -> Result<Vec<String>, ConfigError> {
    let items: Vec<String> = configured
        .split(',')
        .map(|item| item.trim().to_owned())
        .collect();
    if items.iter().any(|item| {
        item.is_empty() || canonical_origin(Some(item)).as_deref() != Some(item.as_str())
    }) {
        return Err(ConfigError::Origins);
    }
    let mut unique = items;
    unique.sort();
    unique.dedup();
    Ok(unique)
}
