//! `verify-state`: a read-only, offline proof that every kept store opens and parses under this Admin.

use crate::{
    json,
    process::config::Config,
    record::{AuthState, StateError, Store},
    space::keys,
};

/// Strictly parses `admin.json`, `team-order.json`, and the chat history, answering their record counts.
///
/// # Errors
///
/// Returns the first store that does not parse.
pub fn verify(config: &Config, store: &Store) -> Result<String, StateError> {
    let state = store.authentication_state()?;
    let data = store.get()?;
    if state != AuthState::Uninitialized {
        store
            .local_supervisor()
            .map_err(|_| StateError::Authority)?;
    }
    let passkeys = data
        .get("passkeys")
        .and_then(json::as_array)
        .map_or(0, <[_]>::len);
    let models = keys::models::status(store).map_err(|_| StateError::Credential)?;
    let configured = json::get(&models, "providers")
        .and_then(json::as_array)
        .unwrap_or_default()
        .iter()
        .filter(|provider| json::get(provider, "configured") == Some(&json::Value::Bool(true)))
        .count();
    let decision = keys::decision::resolve(store).map_err(|_| StateError::Credential)?;
    let ordered = crate::team::order::load(&config.team_order_path)
        .map_err(|_| StateError::Corrupt)?
        .map_or(0, |ids| ids.len());
    let history =
        crate::history::store::verify(&config.history_path()).map_err(|_| StateError::Corrupt)?;
    Ok(format!(
        "authentication_state={}\npasskeys={passkeys}\nmodel_keys={configured}\ndecision_key={}\n\
         ordered_teams={ordered}\nhistory_entries={history}\n",
        state.name(),
        u8::from(decision.is_some()),
    ))
}

#[cfg(test)]
mod tests;
