//! The Space's methods of the session socket.

use crate::{fault::Outcome, session::calls::Call};

/// `platform.release`.
///
/// # Errors
///
/// Returns 503 when the status is unavailable.
pub async fn platform_release(call: &Call) -> Outcome {
    let path = call.app().config.release_status_path.clone();
    call.on_lane(async move { super::release::status_response(&path) })
        .await
}
