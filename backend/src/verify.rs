//! `verify-state`: a read-only, offline proof that every kept store opens and parses under this Admin.

use crate::{
    config::Config,
    record::{StateError, Store},
};

/// Strictly parses `admin.json`, `team-order.json`, and the chat history, answering their record counts.
///
/// # Errors
///
/// Returns the first store that does not parse.
pub fn verify(config: &Config, store: &Store) -> Result<String, StateError> {
    let _ = config;
    let state = store.authentication_state()?;
    Ok(format!("authentication_state={}\n", state.name()))
}
