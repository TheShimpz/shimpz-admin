//! The model provider keys and the decision key the store keeps for trusted backend callers only: never a route, never
//! Team inference metadata.

use super::{StateError, Store};
use crate::json::{self, Value};

impl Store {
    /// The private model-credential records, by provider.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Credential`] for a record Admin does not write.
    pub fn model_credentials(&self) -> Result<Value, StateError> {
        match self.get()?.get("model_credentials") {
            None => Ok(json::empty()),
            Some(records) if json::members(records).is_some() => Ok(records.clone()),
            Some(_) => Err(StateError::Credential),
        }
    }

    /// Atomically persists one remotely verified provider key, then raises `space/models`.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Credential`] for invalid stored records, or a store error.
    pub fn set_model_api_key(&self, provider: &str, api_key: &str) -> Result<(), StateError> {
        let now = self.now();
        self.mutate_always(|data| {
            let mut records = match data.get("model_credentials") {
                None => json::empty(),
                Some(records) if json::members(records).is_some() => records.clone(),
                Some(_) => return Err(StateError::Credential),
            };
            json::set(
                &mut records,
                provider,
                json::object(vec![
                    ("api_key", json::text(api_key)),
                    ("verified_at", json::int(now)),
                ]),
            );
            json::set(data, "model_credentials", records);
            Ok(())
        })?;
        self.topics.changed("space/models");
        Ok(())
    }

    /// The private decision-key record, unchecked.
    ///
    /// # Errors
    ///
    /// Returns a store error.
    pub fn decision_credential(&self) -> Result<Option<Value>, StateError> {
        Ok(self.get()?.get("decision_credential").cloned())
    }

    /// Atomically persists the remotely verified decision key, then raises `space/decision`.
    ///
    /// # Errors
    ///
    /// Returns a store error.
    pub fn set_decision_api_key(&self, api_key: &str) -> Result<(), StateError> {
        let now = self.now();
        self.mutate_always(|data| {
            json::set(
                data,
                "decision_credential",
                json::object(vec![
                    ("api_key", json::text(api_key)),
                    ("verified_at", json::int(now)),
                ]),
            );
            Ok(())
        })?;
        self.topics.changed("space/decision");
        Ok(())
    }

    /// Deletes the decision key without disturbing model keys or the session; a removal raises `space/decision`.
    ///
    /// # Errors
    ///
    /// Returns a store error.
    pub fn delete_decision_api_key(&self) -> Result<(), StateError> {
        let removed = self.mutate(
            |data| {
                Ok(json::remove(data, "decision_credential")
                    .is_some_and(|value| !matches!(value, Value::Null)))
            },
            |removed| *removed,
            None,
        )?;
        if removed {
            self.topics.changed("space/decision");
        }
        Ok(())
    }
}
