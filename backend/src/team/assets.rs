//! Same-origin icons Team holds.

/// The route's handler (its port lands with its domain).
pub async fn assistant_icon(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn local_assistant_icon(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
