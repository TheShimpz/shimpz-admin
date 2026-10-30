//! The Browser view relay.

/// The route's handler (its port lands with its domain).
pub async fn stream(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn control(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
