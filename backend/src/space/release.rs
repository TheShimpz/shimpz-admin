//! The bounded Local platform-release status the release-bound CLI projects.

use std::{path::Path, sync::LazyLock};

use team_protocol::python::regex::{Pattern, declared};

use crate::{
    fault::{Fault, Outcome, Reply},
    fsio::{self, Requirements},
    json::{self, Value},
};

/// The largest status file.
pub const MAX_STATUS_BYTES: u64 = 1024;
/// 9999-12-31T23:59:59Z.
pub const MAX_CHECKED_AT: i64 = 253_402_300_799;
const OUTCOMES: [&str; 3] = ["current", "updated", "rollback-needed"];
const FIELDS: [&str; 4] = ["release", "ordinal", "checked_at", "outcome"];
/// A published release set, or a developer release built on this host (ADR-0099).
static RELEASE: LazyLock<Pattern> = LazyLock::new(|| {
    declared(r"(?:ghcr\.io/theshimpz|localhost)/shimpz-local-release@sha256:[0-9a-f]{64}\Z")
});

/// The CLI status is absent or fails its closed projection contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unavailable;

/// The status document at `path`.
///
/// # Errors
///
/// Returns [`Unavailable`] for an absent, unsafe, or invalid file.
pub fn read_status(path: &Path) -> Result<Value, Unavailable> {
    let raw = fsio::read_private(path, MAX_STATUS_BYTES, Requirements::default())
        .map_err(|_| Unavailable)?;
    let document = json::parse(&raw).map_err(|_| Unavailable)?;
    let positive = |key: &str, maximum: i64| {
        json::get(&document, key)
            .and_then(json::as_int)
            .is_some_and(|value| 0 < value && value <= maximum)
    };
    let admitted = json::has_exactly(&document, &FIELDS)
        && json::get_str(&document, "release").is_some_and(|release| RELEASE.is_full(release))
        && positive("ordinal", i64::MAX)
        && positive("checked_at", MAX_CHECKED_AT)
        && json::get_str(&document, "outcome").is_some_and(|outcome| OUTCOMES.contains(&outcome));
    if admitted {
        Ok(document)
    } else {
        Err(Unavailable)
    }
}

/// The status as the page shows it, its check time in UTC.
///
/// # Errors
///
/// Returns 503 when the status is unavailable.
pub fn status_response(path: &Path) -> Outcome {
    let mut document = read_status(path).map_err(|Unavailable| {
        Fault::detail(503, "Local platform release status is unavailable")
    })?;
    let checked_at = json::get(&document, "checked_at")
        .and_then(json::as_int)
        .unwrap_or_default();
    json::set(
        &mut document,
        "checked_at",
        json::text(crate::timefmt::utc(checked_at)),
    );
    Ok(Reply::ok(document))
}

#[cfg(test)]
mod tests;
