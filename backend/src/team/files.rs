//! A Team's files over HTTP: the upload, a file's previews, and its download.

/// The route's handler (its port lands with its domain).
pub async fn upload(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn preview(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn page_preview(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn download(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
