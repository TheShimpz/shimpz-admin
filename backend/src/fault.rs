//! An operation's answer and the closed ways it fails, each answered as Admin's HTTP gate answers it.

use crate::json::{self, Value};

/// One answer: an HTTP status and its JSON body (Team's response, a route's result, or a call's result).
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    /// The HTTP status.
    pub status: u16,
    /// The JSON body.
    pub body: Value,
}

impl Reply {
    /// An answer of `status` with `body`.
    #[must_use]
    pub const fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// A 200 answer with `body`.
    #[must_use]
    pub const fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    /// `{"detail": detail}` with `status`.
    #[must_use]
    pub fn detail(status: u16, detail: &str) -> Self {
        Self::new(status, json::detail(detail))
    }

    /// Whether the status is 2xx.
    #[must_use]
    pub const fn success(&self) -> bool {
        self.status >= 200 && self.status < 300
    }

    /// `body.get(key)`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.body.get(key)
    }

    /// `body.get(key)` as text.
    #[must_use]
    pub fn get_str(&self, key: &str) -> Option<&str> {
        json::get_str(&self.body, key)
    }
}

/// A refusal answered as `FastAPI` answers an `HTTPException`: its status, its body, and a `Retry-After` when locked.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    /// The HTTP status.
    pub status: u16,
    /// The JSON body.
    pub body: Value,
    /// Seconds a locked ceremony asks the browser to wait.
    pub retry_after: Option<u64>,
}

impl Refusal {
    /// `{"detail": detail}` with `status`.
    #[must_use]
    pub fn detail(status: u16, detail: &str) -> Self {
        Self {
            status,
            body: json::detail(detail),
            retry_after: None,
        }
    }

    /// `body` with `status`.
    #[must_use]
    pub const fn body(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            retry_after: None,
        }
    }

    /// The same refusal with a `Retry-After` of `seconds`.
    #[must_use]
    pub const fn retry_after(mut self, seconds: u64) -> Self {
        self.retry_after = Some(seconds);
        self
    }

    /// The refusal as an answer.
    #[must_use]
    pub fn reply(&self) -> Reply {
        Reply::new(self.status, self.body.clone())
    }
}

/// How an operation failed before it could answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Fault {
    /// A refusal the browser is answered with as it is.
    Refused(Refusal),
    /// Admin refused the browser's request before any Team call (`TeamRequestError`), with its reason.
    TeamRequest(String),
    /// The Local Supervisor's signing authority is unavailable or invalid.
    Authority,
    /// The stored password record needs bounded recovery.
    PasswordRecord,
    /// A stored model or decision key record is not one Admin writes.
    CredentialRecord,
    /// The authentication journal cannot record the change.
    Audit,
    /// The chat history cannot be read or committed.
    History,
    /// Anything else: the server error HTTP answers.
    Internal,
    /// The session socket closed, or lost its Origin or session, before the call ran: the call is never answered.
    Closed,
}

impl Fault {
    /// `{"detail": detail}` with `status`.
    #[must_use]
    pub fn detail(status: u16, detail: &str) -> Self {
        Self::Refused(Refusal::detail(status, detail))
    }

    /// `body` with `status`.
    #[must_use]
    pub const fn body(status: u16, body: Value) -> Self {
        Self::Refused(Refusal::body(status, body))
    }

    /// A browser-invalid request Admin refuses before any Team call.
    #[must_use]
    pub fn team_request(reason: impl Into<String>) -> Self {
        Self::TeamRequest(reason.into())
    }

    /// The answer Admin's HTTP gate and the session socket give this failure; a refused request before any Team call
    /// is the gate's 503 unless the operation itself answered it as its own 400 ([`Self::bad_request`]).
    #[must_use]
    pub fn reply(&self) -> Reply {
        match self {
            Self::Refused(refusal) => refusal.reply(),
            Self::TeamRequest(_) | Self::Authority => {
                Reply::detail(503, "Supervisor authority is unavailable")
            }
            Self::PasswordRecord => Reply::new(
                503,
                json::object(vec![
                    ("code", json::text("password-recovery-required")),
                    (
                        "detail",
                        json::text("Supervisor password recovery is required"),
                    ),
                ]),
            ),
            Self::CredentialRecord => Reply::new(
                503,
                json::object(vec![
                    ("code", json::text("credential-record-invalid")),
                    (
                        "detail",
                        json::text(
                            "A stored key record is invalid; reset the Space with shimpz reset",
                        ),
                    ),
                ]),
            ),
            Self::Audit => Reply::detail(503, "Supervisor authentication audit is unavailable"),
            Self::History => Reply::detail(503, "Admin chat history is unavailable"),
            Self::Internal | Self::Closed => Reply::detail(500, "Internal Server Error"),
        }
    }

    /// `refused_as_bad_request`: a request Admin refused before any Team call is the browser's own 400 with its reason.
    #[must_use]
    pub fn bad_request(self) -> Self {
        match self {
            Self::TeamRequest(reason) => Self::detail(400, &reason),
            other => other,
        }
    }
}

impl From<Refusal> for Fault {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// The result of one operation.
pub type Outcome<T = Reply> = Result<T, Fault>;
