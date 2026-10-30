//! The chat, history, catalog, and Integration methods of the session socket.

use crate::{fault::Outcome, session::calls::Call};

/// `history_page`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn history_page(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `chat_limit_read`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn chat_limit_read(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `chat_limit_save`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn chat_limit_save(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `store_catalog`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn store_catalog(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `integrations_list`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn integrations_list(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `integrations_authorize`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn integrations_authorize(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `integrations_complete`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn integrations_complete(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}

/// `integrations_cancel`.
///
/// # Errors
///
/// Returns the operation's fault.
pub async fn integrations_cancel(call: &Call) -> Outcome {
    crate::session::methods::unported(call).await
}
