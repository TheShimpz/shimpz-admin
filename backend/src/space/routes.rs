//! The Space's reset routes.

/// The route's handler (its port lands with its domain).
pub async fn space_reset(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn host_reset(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
