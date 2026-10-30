//! A fake Local Team: it refuses any bearer but the one it was started with, verifies every Supervisor and Routine
//! assertion exactly as Team does (signature under the published key, canonical claims, the method, path, and body
//! digest they bind), records each request, and answers what the test scripts.

use std::{
    convert::Infallible,
    sync::{Arc, Mutex, Weak},
};

use admin_backend::{
    json::{self, Value},
    process::app::App,
};
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use futures_util::stream;
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};

/// One request Team received.
#[derive(Clone, Debug)]
pub struct Recorded {
    /// The method.
    pub method: String,
    /// The path.
    pub path: String,
    /// The headers.
    pub headers: HeaderMap,
    /// The body.
    pub body: Vec<u8>,
    /// The verified claims of its Supervisor or Routine assertion, or why it failed verification.
    pub assertion: Option<Result<Value, String>>,
}

impl Recorded {
    /// The body as JSON.
    #[must_use]
    pub fn json(&self) -> Value {
        json::parse(&self.body).unwrap_or(Value::Null)
    }
}

/// What Team answers one request with.
pub enum Answer {
    /// A JSON body.
    Json(u16, Value),
    /// A chunked NDJSON stream: these progress records, then the terminal of this status and body.
    Stream(Vec<Value>, u16, Value),
    /// A stream that never ends: Admin dies, or Team does, while the turn runs.
    Hang,
}

type Script = Box<dyn Fn(&Recorded) -> Option<Answer> + Send + Sync>;

struct State {
    bearer: String,
    scripts: Mutex<Vec<Script>>,
    requests: Mutex<Vec<Recorded>>,
    admin: Mutex<Weak<App>>,
}

/// The fake Team.
#[derive(Clone)]
pub struct FakeTeam {
    /// Its URL.
    pub url: String,
    state: Arc<State>,
}

fn json_response(status: u16, body: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(json::compact(body)))
        .unwrap()
}

fn stream_response(progress: Vec<Value>, status: u16, body: Value) -> Response {
    let mut lines: Vec<Result<Bytes, Infallible>> = progress
        .into_iter()
        .map(|record| Ok(Bytes::from(format!("{}\n", json::compact(&record)))))
        .collect();
    let terminal = json::object(vec![
        ("type", json::text("terminal")),
        ("status", json::int(i64::from(status))),
        ("body", body),
    ]);
    lines.push(Ok(Bytes::from(format!("{}\n", json::compact(&terminal)))));
    Response::builder()
        .status(200)
        .header("content-type", "application/x-ndjson")
        .body(Body::from_stream(stream::iter(lines)))
        .unwrap()
}

impl FakeTeam {
    /// Starts Team on a loopback port, admitting only `bearer`.
    pub async fn start(bearer: &str) -> Self {
        let state = Arc::new(State {
            bearer: bearer.to_owned(),
            scripts: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
            admin: Mutex::new(Weak::new()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let served = Arc::clone(&state);
        let router = axum::Router::new().fallback(move |request: Request| {
            let state = Arc::clone(&served);
            async move { handle(&state, request).await }
        });
        tokio::spawn(async move { axum::serve(listener, router).await });
        Self { url, state }
    }

    /// Verifies assertions under the Supervisor and Routine keys `app` publishes.
    pub fn verify_with(&self, app: &Arc<App>) {
        *self.state.admin.lock().unwrap() = Arc::downgrade(app);
    }

    /// Answers every request `script` answers; scripts added later take precedence.
    pub fn script(&self, script: impl Fn(&Recorded) -> Option<Answer> + Send + Sync + 'static) {
        self.state
            .scripts
            .lock()
            .unwrap()
            .insert(0, Box::new(script));
    }

    /// Answers `method path` with a JSON body.
    pub fn on(&self, method: &str, path: &str, status: u16, body: Value) {
        let (method, path) = (method.to_owned(), path.to_owned());
        self.script(move |request| {
            (request.method == method && request.path == path)
                .then(|| Answer::Json(status, body.clone()))
        });
    }

    /// Every request received so far.
    #[must_use]
    pub fn requests(&self) -> Vec<Recorded> {
        self.state.requests.lock().unwrap().clone()
    }

    /// The requests received at `path`.
    #[must_use]
    pub fn requests_to(&self, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|request| request.path == path)
            .collect()
    }
}

async fn handle(state: &State, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = body
        .collect()
        .await
        .map(|collected| collected.to_bytes().to_vec())
        .unwrap_or_default();
    if parts
        .headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(&format!("Bearer {}", state.bearer))
    {
        return json_response(
            401,
            &json::object(vec![("error", json::text("authentication required"))]),
        );
    }
    let admin = state.admin.lock().unwrap().upgrade();
    let mut recorded = Recorded {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        headers: parts.headers,
        body,
        assertion: None,
    };
    recorded.assertion = admin.and_then(|app| verify(&app, &recorded));
    state.requests.lock().unwrap().push(recorded.clone());
    let answer = state
        .scripts
        .lock()
        .unwrap()
        .iter()
        .find_map(|script| script(&recorded));
    match answer {
        Some(Answer::Json(status, body)) => json_response(status, &body),
        Some(Answer::Stream(progress, status, body)) => stream_response(progress, status, body),
        Some(Answer::Hang) => Response::builder()
            .status(200)
            .header("content-type", "application/x-ndjson")
            .body(Body::from_stream(stream::pending::<
                Result<Bytes, Infallible>,
            >()))
            .unwrap(),
        None => json_response(
            StatusCode::NOT_FOUND.as_u16(),
            &json::detail("not scripted"),
        ),
    }
}

/// The verified claims of a request's assertion, or why verification failed; `None` without one.
fn verify(app: &App, request: &Recorded) -> Option<Result<Value, String>> {
    let header = |name: &str| {
        request
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let (token, audience, routine) =
        match (header("x-shimpz-supervisor"), header("x-shimpz-routine")) {
            (Some(token), None) => (token, "team-local", false),
            (None, Some(token)) => (token, "team-local-routine", true),
            (None, None) => return None,
            _ => return Some(Err("two assertions".to_owned())),
        };
    Some(verified(app, request, token, audience, routine))
}

fn verified(
    app: &App,
    request: &Recorded,
    token: &str,
    audience: &str,
    routine: bool,
) -> Result<Value, String> {
    let token = token.strip_prefix("Bearer ").ok_or("no bearer scheme")?;
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return Err("not a compact JWS".to_owned());
    };
    let record = app.store.get().map_err(|_| "store")?;
    let (id, key) = if routine {
        ("routine_subject", "routine_signing_key")
    } else {
        ("supervisor_id", "supervisor_signing_key")
    };
    let identity =
        admin_backend::supervisor::identity::LocalIdentity::from_record(&record, id, key)
            .map_err(|_| "no identity")?;
    let public = identity.public_key_raw();
    let signature = BASE64URL_NOPAD
        .decode(signature.as_bytes())
        .map_err(|_| "signature encoding")?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public)
        .verify(format!("{header}.{payload}").as_bytes(), &signature)
        .map_err(|_| "signature")?;
    let claims = json::parse(
        &BASE64URL_NOPAD
            .decode(payload.as_bytes())
            .map_err(|_| "payload encoding")?,
    )
    .map_err(|_| "payload json")?;
    let canonical = team_protocol::supervisor::claims_json(&claims, audience)
        .map_err(|error| error.to_string())?;
    if canonical
        != BASE64URL_NOPAD
            .decode(payload.as_bytes())
            .unwrap_or_default()
    {
        return Err("claims are not canonical".to_owned());
    }
    if json::get_str(&claims, "method") != Some(request.method.as_str())
        || json::get_str(&claims, "path") != Some(request.path.as_str())
    {
        return Err("claims name another request".to_owned());
    }
    let body = json::get(&claims, "body").ok_or("no body claim")?;
    if json::get_str(body, "kind") == Some("json")
        && json::get_str(body, "sha256")
            != Some(HEXLOWER.encode(&Sha256::digest(&request.body)).as_str())
    {
        return Err("body digest".to_owned());
    }
    Ok(claims)
}
