//! The integration harness: one Admin served in-process on a loopback port, its files in a temporary directory, and a
//! fake Team that verifies Admin's bearer and assertions and answers what each test scripts.

pub mod client;
pub mod socket;
pub mod team;

use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc};

use admin_backend::{
    app::App,
    clock::Clock,
    config::{Config, Outbound},
    json,
    signin::{token, totp},
};

/// A served Admin and what it was built from.
pub struct Admin {
    /// The process state.
    pub app: Arc<App>,
    /// The loopback URL it serves.
    pub url: String,
    /// The temporary directory holding every file, removed with the Admin.
    pub _root: tempfile::TempDir,
    /// The fake Team.
    pub team: team::FakeTeam,
    /// The clock tests move.
    pub clock: Arc<Clock>,
}

/// The loopback origin the CLI admits.
pub const ORIGIN: &str = "http://127.0.0.1:7777";
/// The Supervisor's test password.
pub const PASSWORD: &str = "correct horse battery staple x";

fn directory(path: &Path, mode: u32) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A configuration under `root`, its Team at `team_url`.
#[must_use]
pub fn config(root: &Path, team_url: &str) -> Config {
    let mut config = Config::under(root);
    team_url.clone_into(&mut config.team_url);
    config.outbound = Outbound::Local("127.0.0.1:9".parse().unwrap());
    directory(&root.join("data"), 0o700);
    directory(&root.join("run"), 0o700);
    directory(&root.join("supervisor"), 0o2770);
    directory(&root.join("release"), 0o700);
    directory(&root.join("reset"), 0o700);
    std::fs::write(&config.team_token_file, "team-bearer-token").unwrap();
    config
}

impl Admin {
    /// An Admin with a fresh store and a fake Team.
    pub async fn start() -> Self {
        Self::start_with(|_| {}).await
    }

    /// An Admin whose configuration `adjust` changes first.
    pub async fn start_with(adjust: impl FnOnce(&mut Config)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let team = team::FakeTeam::start("team-bearer-token").await;
        let mut config = config(root.path(), &team.url);
        adjust(&mut config);
        let clock = Arc::new(Clock::new());
        let app = App::with_clock(config, Arc::clone(&clock));
        team.verify_with(&app);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(admin_backend::http::serve(Arc::clone(&app), listener));
        Self {
            app,
            url,
            _root: root,
            team,
            clock,
        }
    }

    /// Configures the Supervisor directly in the store (password and an active TOTP) and returns a current session
    /// cookie value, for tests whose subject is not the sign-in ceremony itself.
    pub fn signed_in(&self) -> String {
        let store = &self.app.store;
        let verifier = admin_backend::signin::password::new_password_verifier(PASSWORD).unwrap();
        store.begin_supervisor_setup(&verifier).unwrap();
        let data = store.get().unwrap();
        let secret = json::get_str(json::get(&data, "totp").unwrap(), "secret")
            .unwrap()
            .to_owned();
        let codes = admin_backend::signin::recovery::new_set();
        let code = json::text(totp::code_at(&secret, self.clock.now_secs()));
        let accepted = store
            .verify_totp(
                &code,
                admin_backend::record::Ceremony::Setup,
                None,
                Some(&codes.record),
                &|_| Ok(()),
            )
            .unwrap();
        assert_eq!(accepted, totp::Verification::Accepted);
        let identity = store.local_supervisor().unwrap();
        admin_backend::supervisor::identity::materialize(
            &self.app.config.public_key_file,
            self.app.config.key_group,
            &identity,
        )
        .unwrap();
        self.session()
    }

    /// A fresh session cookie of the configured Supervisor.
    #[must_use]
    pub fn session(&self) -> String {
        let secret = self.app.store.session_secret().unwrap();
        token::issue(
            &self.app.sessions,
            &secret,
            token::Method::Totp,
            self.clock.now_secs(),
        )
    }
}
