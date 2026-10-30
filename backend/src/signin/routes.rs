//! The sign-in ceremonies' HTTP routes.

/// The route's handler (its port lands with its domain).
pub async fn session(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn login(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn logout(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn setup(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn setup_totp(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn login_totp(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn login_passkey(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn login_recovery(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn recovery_totp(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn passkey_registration(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}

/// The route's handler (its port lands with its domain).
pub async fn passkey_registered(request: axum::extract::Request) -> axum::response::Response {
    crate::http::unknown_api(request).await
}
