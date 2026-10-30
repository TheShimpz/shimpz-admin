//! Exact public event projections for chat on the session socket.

use crate::json::{self, Value};

/// The longest public error detail.
pub const MAX_PUBLIC_ERROR_CHARS: i64 = 800;
const FALLBACK: &str = "local chat request failed";

/// An error terminal of a safe status and `detail` when it is public-safe, else the generic detail.
#[must_use]
pub fn error_terminal(status: u16, detail: &str) -> Value {
    team_protocol::websocket::error_terminal(
        &json::int(i64::from(status)),
        detail,
        FALLBACK,
        MAX_PUBLIC_ERROR_CHARS,
    )
}
