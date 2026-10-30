//! The public Store catalog's icons.

/// The route's handler (its port lands with its domain).
pub async fn catalog_icon(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
