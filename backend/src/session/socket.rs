//! The session socket.

/// The route's handler (its port lands with its domain).
pub async fn upgrade(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
