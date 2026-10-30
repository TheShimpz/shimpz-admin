//! The bounded authenticated HTTP transport from Admin to the Local Team.
//!
//! Every request carries Team's machine bearer (re-read once when Team refuses the cached one) and, under a Supervisor
//! scope, a short-lived assertion binding the exact method, path, and body to that authority. Each exchange uses its
//! own connection: Team answers with `Connection: close`, and no authenticated connection outlives a bearer rotation.
//! Failures never carry Team's or the transport's text: they are Admin's own fixed answers.

mod decode;
mod exchange;
mod headers;

use std::{path::PathBuf, sync::Arc, sync::Mutex, time::Duration};

pub use decode::{AssetReply, Image};
pub use headers::{Bindings, Scope};

use crate::{
    fault::{Fault, Reply},
    json::{self, Value},
    supervisor::assertion::AuthorityKind,
    supervisor::identity::LocalIdentity,
    time::clock::Clock,
};

/// The largest JSON request body Admin sends by default.
pub const MAX_JSON_BODY_BYTES: usize = 16 * 1024;
/// The largest JSON answer Admin reads by default.
pub const MAX_JSON_RESPONSE_BYTES: usize = 256 * 1024;
/// The longest Admin waits on a silent Team by default.
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(180);
/// The longest Admin waits to reach Team for one upgraded stream.
pub const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Team could not be reached for an upgraded stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unreachable;

/// Where Team listens and where its bearer is.
pub struct TeamClient {
    endpoint: Option<(String, u16)>,
    token_file: PathBuf,
    token: Mutex<Option<headers::TokenCache>>,
    clock: Arc<Clock>,
}

/// One call's bounds and private bindings.
#[derive(Clone, Debug)]
pub struct Options {
    /// The longest Team may stay silent.
    pub timeout: Duration,
    /// The largest request body.
    pub body_limit: usize,
    /// The largest answer.
    pub response_limit: usize,
    /// The private model credential, assurance, decision key, or Routine lease the request carries.
    pub bindings: Bindings,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            timeout: CONTROL_TIMEOUT,
            body_limit: MAX_JSON_BODY_BYTES,
            response_limit: MAX_JSON_RESPONSE_BYTES,
            bindings: Bindings::default(),
        }
    }
}

/// `{"detail": "team unavailable"}` with 502: Team could not answer, or answered outside its contract.
#[must_use]
pub fn unavailable() -> Reply {
    Reply::detail(502, "team unavailable")
}

fn endpoint(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() || authority.contains(['/', '?', '#', '@', '[', ']']) {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok().filter(|port| *port > 0)?),
        None => (authority, 7077),
    };
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

impl TeamClient {
    /// The client of Team at `url` (`http://host[:port]`), whose bearer Team writes to `token_file`.
    #[must_use]
    pub fn new(url: &str, token_file: PathBuf, clock: Arc<Clock>) -> Self {
        Self {
            endpoint: endpoint(url),
            token_file,
            token: Mutex::new(None),
            clock,
        }
    }
}

/// A Team handle: the client and the Supervisor authority its calls are signed for, if any.
#[derive(Clone)]
pub struct Team {
    client: Arc<TeamClient>,
    scope: Option<Arc<Scope>>,
}

/// What reading an exchange's answer takes.
enum Reading<'a> {
    Json(usize),
    Stream(&'a (dyn Fn(Value) + Send + Sync)),
    Image(Image),
    Content,
}

impl Team {
    /// Team without any Supervisor authority: the bearer alone (Routine claims and notices).
    #[must_use]
    pub const fn machine(client: Arc<TeamClient>) -> Self {
        Self {
            client,
            scope: None,
        }
    }

    /// Team under one validated Supervisor authority.
    #[must_use]
    pub fn scoped(client: Arc<TeamClient>, scope: Scope) -> Self {
        Self {
            client,
            scope: Some(Arc::new(scope)),
        }
    }

    /// Team under a Supervisor session's authority: its cookie value and the current signing identity.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for a session value outside the assertion's grammar.
    pub fn session(
        client: Arc<TeamClient>,
        value: &str,
        identity: LocalIdentity,
    ) -> Result<Self, Fault> {
        Ok(Self::scoped(
            client,
            Scope::new(value, identity, AuthorityKind::Session)?,
        ))
    }

    /// The underlying client.
    #[must_use]
    pub fn client(&self) -> &Arc<TeamClient> {
        &self.client
    }

    /// The Supervisor authority the calls are signed for.
    #[must_use]
    pub fn scope(&self) -> Option<&Scope> {
        self.scope.as_deref()
    }

    /// One JSON call with the default bounds.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for a request body Admin refuses to send.
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        payload: Option<&Value>,
    ) -> Result<Reply, Fault> {
        self.call_with(method, path, payload, Options::default())
            .await
    }

    /// One JSON call with these bounds and bindings.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for a request body Admin refuses to send.
    pub async fn call_with(
        &self,
        method: &str,
        path: &str,
        payload: Option<&Value>,
        options: Options,
    ) -> Result<Reply, Fault> {
        let body = encode(payload, options.body_limit)?;
        let entity = headers::Entity {
            body: body.as_deref(),
            content_type: body.as_ref().map(|_| "application/json"),
            filename: None,
        };
        let reading = Reading::Json(options.response_limit);
        Ok(self
            .exchange(method, path, &entity, &options, &reading)
            .await
            .into_reply())
    }

    /// One chat or Routine stream: its progress handed to `progress` in order, then its terminal answer.
    ///
    /// # Errors
    ///
    /// Returns [`Fault::TeamRequest`] for a request body Admin refuses to send.
    pub async fn call_stream(
        &self,
        method: &str,
        path: &str,
        payload: &Value,
        options: Options,
        progress: &(dyn Fn(Value) + Send + Sync),
    ) -> Result<Reply, Fault> {
        let body = encode(Some(payload), options.body_limit)?
            .ok_or_else(|| Fault::team_request("stream request body is required"))?;
        let entity = headers::Entity {
            body: Some(&body),
            content_type: Some("application/json"),
            filename: None,
        };
        let reading = Reading::Stream(progress);
        Ok(self
            .exchange(method, path, &entity, &options, &reading)
            .await
            .into_reply())
    }

    /// One file upload's raw bytes, named and typed in private headers.
    pub async fn call_raw(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        filename: &str,
        media_type: &str,
    ) -> Reply {
        let entity = headers::Entity {
            body: Some(body),
            content_type: Some(media_type),
            filename: Some(filename),
        };
        let reading = Reading::Json(MAX_JSON_RESPONSE_BYTES);
        self.exchange(method, path, &entity, &Options::default(), &reading)
            .await
            .into_reply()
    }

    /// One image Team holds (an Assistant icon or a file preview), or Team's JSON refusal.
    pub async fn call_image(&self, path: &str, image: Image) -> AssetReply {
        self.exchange(
            "GET",
            path,
            &headers::Entity::default(),
            &Options::default(),
            &Reading::Image(image),
        )
        .await
        .into_asset()
    }

    /// One file's original, verified against Team's declared digest before any byte is sent on.
    pub async fn call_content(&self, path: &str) -> AssetReply {
        self.exchange(
            "GET",
            path,
            &headers::Entity::default(),
            &Options::default(),
            &Reading::Content,
        )
        .await
        .into_asset()
    }

    /// A connection to Team for one upgraded stream at `path`, the headers that authorize it, and its URI.
    ///
    /// # Errors
    ///
    /// Returns [`Unreachable`] when Team cannot be reached or the request cannot be authorized.
    pub async fn stream_connection(
        &self,
        path: &str,
    ) -> Result<(tokio::net::TcpStream, Vec<(String, String)>, String), Unreachable> {
        let (host, port) = self.client.endpoint.clone().ok_or(Unreachable)?;
        let headers = self
            .request_headers(
                "GET",
                path,
                &headers::Entity::default(),
                "*/*",
                &Bindings::default(),
            )
            .map_err(|()| Unreachable)?;
        let stream = tokio::time::timeout(
            STREAM_CONNECT_TIMEOUT,
            tokio::net::TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| Unreachable)?
        .map_err(|_| Unreachable)?;
        Ok((stream, headers, format!("ws://{host}:{port}{path}")))
    }
}

fn encode(payload: Option<&Value>, limit: usize) -> Result<Option<Vec<u8>>, Fault> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if json::members(payload).is_none() {
        return Err(Fault::team_request("request body must be a JSON object"));
    }
    let body = json::compact(payload).into_bytes();
    if body.len() > limit {
        return Err(Fault::team_request(format!(
            "request body exceeds {limit} bytes"
        )));
    }
    Ok(Some(body))
}

#[cfg(test)]
mod tests;
