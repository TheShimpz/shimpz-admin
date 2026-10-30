//! `shimpz-admin`'s closed commands: serve Admin, check its health, and the bounded one-shot helpers the release-bound
//! CLI runs with the Admin image (each reads or writes exactly one owned file).

use std::{
    ffi::OsString,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    process::ExitCode,
    time::Duration,
};

use rustix::fs::OFlags;

use crate::{
    app::App,
    config::Config,
    json,
    record::{StateError, Store},
};

const USAGE: &str = "usage: shimpz-admin [serve | healthcheck | authentication-state | verify-state | release-status write \
                     | reset-capability write | reset-capability clear]\n";
/// The largest document a helper reads from its standard input.
pub const MAX_HELPER_BYTES: usize = 1024;
/// The fields of the platform release status the CLI projects.
pub const STATUS_FIELDS: [&str; 4] = ["release", "ordinal", "checked_at", "outcome"];
/// The fields of the host reset capability the CLI projects.
pub const CAPABILITY_FIELDS: [&str; 6] = [
    "version",
    "purpose",
    "space_id",
    "created_at",
    "expires_at",
    "capability_sha256",
];

/// Writes one structured log line of a fixed event name, never a value.
pub fn log(level: &str, event: &str) {
    let line = json::compact(&json::object(vec![
        ("level", json::text(level)),
        ("event", json::text(event)),
    ]));
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// A payload-free panic hook: a panic is reported by its location alone, never its message, so no secret a panicking
/// value held can reach a log.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map_or_else(String::new, |location| {
            format!("{}:{}", location.file(), location.line())
        });
        let line = json::compact(&json::object(vec![
            ("level", json::text("error")),
            ("event", json::text("panic")),
            ("location", json::text(location)),
        ]));
        let _ = writeln!(std::io::stderr(), "{line}");
    }));
}

/// Runs the command `arguments` name.
#[must_use]
pub fn run(arguments: &[OsString]) -> ExitCode {
    let words: Vec<&str> = arguments
        .iter()
        .map(|argument| argument.to_str().unwrap_or("\u{0}"))
        .collect();
    match words.as_slice() {
        [] | ["serve"] => serve(),
        ["healthcheck"] => healthcheck(),
        ["authentication-state"] => authentication_state(),
        ["verify-state"] => verify_state(),
        ["release-status", "write"] => exit(write_helper(
            &production().release_status_path,
            &STATUS_FIELDS,
            false,
        )),
        ["reset-capability", "write"] => exit(write_helper(
            &production().reset_capability_path,
            &CAPABILITY_FIELDS,
            true,
        )),
        ["reset-capability", "clear"] => {
            exit(clear_capability(&production().reset_capability_path))
        }
        _ => {
            let _ = std::io::stderr().write_all(USAGE.as_bytes());
            ExitCode::from(2)
        }
    }
}

fn exit(result: Result<(), ()>) -> ExitCode {
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn production() -> Config {
    Config::from_env().unwrap_or_else(|_| Config::under(Path::new("/nonexistent")))
}

fn runtime() -> Option<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .ok()
}

fn serve() -> ExitCode {
    let Ok(config) = Config::from_env() else {
        let _ = std::io::stderr()
            .write_all(b"{\"level\":\"error\",\"event\":\"configuration_invalid\"}\n");
        return ExitCode::FAILURE;
    };
    if crate::app::read_source(&config.revision_file).is_err() {
        let _ = std::io::stderr()
            .write_all(b"{\"level\":\"error\",\"event\":\"source_revision_malformed\"}\n");
        return ExitCode::FAILURE;
    }
    let Some(runtime) = runtime() else {
        return ExitCode::FAILURE;
    };
    runtime.block_on(async move {
        let listen = config.listen;
        let app = App::new(config);
        crate::background::start(&app);
        let Ok(listener) = tokio::net::TcpListener::bind(listen).await else {
            return ExitCode::FAILURE;
        };
        let shutdown = async {
            let _ = tokio::signal::ctrl_c().await;
        };
        let terminate = async {
            if let Ok(mut signal) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                signal.recv().await;
            }
        };
        let server = axum::serve(listener, crate::http::router(app));
        tokio::select! {
            result = server => exit(result.map_err(|_| ())),
            () = shutdown => ExitCode::SUCCESS,
            () = terminate => ExitCode::SUCCESS,
        }
    })
}

fn healthcheck() -> ExitCode {
    let Some(runtime) = runtime() else {
        return ExitCode::FAILURE;
    };
    let probed = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), probe_session())
            .await
            .map_err(|_| ())?
    });
    // The bootstrap answer names only whether the Supervisor is configured: the release smoke reads it here.
    exit(probed.and_then(|body| std::io::stdout().write_all(&body).map_err(|_| ())))
}

/// The largest session bootstrap answer the healthcheck reads.
const MAX_HEALTH_BYTES: usize = 4096;

async fn probe_session() -> Result<Vec<u8>, ()> {
    use http_body_util::BodyExt;
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", 4600))
        .await
        .map_err(|_| ())?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
            .await
            .map_err(|_| ())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let request = http::Request::post("/api/session")
        .header("Host", "127.0.0.1:4600")
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .map_err(|_| ())?;
    let response = sender.send_request(request).await.map_err(|_| ())?;
    if response.status() != http::StatusCode::OK {
        return Err(());
    }
    let body = response
        .into_body()
        .collect()
        .await
        .map_err(|_| ())?
        .to_bytes();
    if body.len() > MAX_HEALTH_BYTES {
        return Err(());
    }
    json::parse(&body)
        .ok()
        .and_then(|value| json::members(&value).map(|_| body.to_vec()))
        .ok_or(())
}

fn store(config: &Config) -> Store {
    let clock = std::sync::Arc::new(crate::clock::Clock::new());
    let sessions = std::sync::Arc::new(crate::signin::sessions::Sessions::new(
        std::sync::Arc::clone(&clock),
    ));
    Store::new(
        config.store_path.clone(),
        clock,
        sessions,
        std::sync::Arc::new(crate::session::topics::Topics::new()),
    )
}

/// Writes exactly one admitted authentication state, without a newline; fails without projecting store details.
fn authentication_state() -> ExitCode {
    match store(&production()).classified_authentication_state() {
        Ok(state) => exit(
            std::io::stdout()
                .write_all(state.name().as_bytes())
                .map_err(|_| ()),
        ),
        Err(_) => ExitCode::FAILURE,
    }
}

fn verify_state() -> ExitCode {
    let config = production();
    match crate::verify::verify(&config, &store(&config)) {
        Ok(counts) => exit(
            std::io::stdout()
                .write_all(counts.as_bytes())
                .map_err(|_| ()),
        ),
        Err(StateError::PasswordRecord) => {
            let _ = std::io::stdout().write_all(b"recovery-required\n");
            ExitCode::FAILURE
        }
        Err(_) => ExitCode::FAILURE,
    }
}

fn read_document(fields: &[&str]) -> Result<Vec<u8>, ()> {
    let mut raw = Vec::new();
    std::io::stdin()
        .take(u64::try_from(MAX_HELPER_BYTES + 1).unwrap_or(1025))
        .read_to_end(&mut raw)
        .map_err(|_| ())?;
    let document = json::parse(&raw).map_err(|_| ())?;
    if raw.is_empty() || raw.len() > MAX_HELPER_BYTES || !json::has_exactly(&document, fields) {
        return Err(());
    }
    Ok(raw)
}

/// Writes the document on standard input to `target` through `target.tmp`, owner-only, never through a symlink;
/// `owned` also requires the file to be a regular single-link file of the Admin identity (1000:1000).
fn write_helper(target: &Path, fields: &[&str], owned: bool) -> Result<(), ()> {
    let raw = read_document(fields)?;
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(".tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(OFlags::NOFOLLOW.bits().cast_signed())
        .open(&temporary)
        .map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if owned
        && (!metadata.file_type().is_file()
            || metadata.nlink() != 1
            || metadata.uid() != 1000
            || metadata.gid() != 1000)
    {
        return Err(());
    }
    file.write_all(&raw).map_err(|_| ())?;
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    drop(file);
    std::fs::rename(&temporary, target).map_err(|_| ())
}

fn clear_capability(target: &Path) -> Result<(), ()> {
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(".tmp");
    for path in [target.as_os_str().to_owned(), temporary] {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
