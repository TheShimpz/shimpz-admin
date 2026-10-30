//! The key methods of the session socket. A save validates the key with its provider and stores it as one detached
//! operation: once started, it completes whatever happens to the socket, which only delivers its result.

use super::{
    decision,
    models::{self, KeyError},
};
use crate::{
    fault::{Fault, Outcome, Reply},
    http::body,
    session::calls::Call,
};

impl From<KeyError> for Fault {
    fn from(error: KeyError) -> Self {
        match error {
            KeyError::Rejected(detail) => Self::detail(400, &detail),
            KeyError::Unavailable(detail) => Self::detail(503, &detail),
            KeyError::Record => Self::CredentialRecord,
            KeyError::Store => Self::Internal,
        }
    }
}

/// `models.list`.
///
/// # Errors
///
/// Returns the store's fault.
pub async fn models_list(call: &Call) -> Outcome {
    let app = std::sync::Arc::clone(call.app());
    call.on_lane(async move { Ok(Reply::ok(models::status(&app.store)?)) })
        .await
}

/// `models.save`.
///
/// # Errors
///
/// Returns 400 for a refused body or key, 503 when the provider cannot confirm it, or the store's fault.
pub async fn models_save(call: &Call) -> Outcome {
    let app = std::sync::Arc::clone(call.app());
    let (provider, payload) = (call.param("provider").clone(), call.body().clone());
    call.on_lane(async move {
        body::exact_fields(&payload, &["api_key"])?;
        let api_key = crate::json::get(&payload, "api_key")
            .cloned()
            .unwrap_or(crate::json::Value::Null);
        let saved = models::configure(&app.store, &app.outbound, &provider, &api_key).await?;
        Ok(Reply::ok(saved))
    })
    .await
}

/// `decision.read`.
///
/// # Errors
///
/// Returns the store's fault.
pub async fn decision_read(call: &Call) -> Outcome {
    let app = std::sync::Arc::clone(call.app());
    call.on_lane(async move { Ok(Reply::ok(decision::status(&app.store)?)) })
        .await
}

/// `decision.save`.
///
/// # Errors
///
/// As [`models_save`].
pub async fn decision_save(call: &Call) -> Outcome {
    let app = std::sync::Arc::clone(call.app());
    let payload = call.body().clone();
    call.on_lane(async move {
        body::exact_fields(&payload, &["api_key"])?;
        let api_key = crate::json::get(&payload, "api_key")
            .cloned()
            .unwrap_or(crate::json::Value::Null);
        Ok(Reply::ok(
            decision::configure(&app.store, &app.outbound, &api_key).await?,
        ))
    })
    .await
}

/// `decision.remove`.
///
/// # Errors
///
/// Returns the store's fault.
pub async fn decision_remove(call: &Call) -> Outcome {
    let app = std::sync::Arc::clone(call.app());
    call.on_lane(async move { Ok(Reply::ok(decision::remove(&app.store)?)) })
        .await
}
