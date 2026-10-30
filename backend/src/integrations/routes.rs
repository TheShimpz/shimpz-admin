//! OAuth's browser redirects.

/// The route's handler (its port lands with its domain).
pub async fn oauth_start(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn oauth_callback(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
