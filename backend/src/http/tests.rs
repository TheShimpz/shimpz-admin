use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{body::Body, http::Request, routing::get};
use tower::ServiceExt;

use super::*;

#[tokio::test]
async fn a_panicking_request_is_a_server_error_and_releases_what_it_held() {
    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let calls = Arc::new(AtomicUsize::new(0));
    let (held, counted) = (Arc::clone(&permits), Arc::clone(&calls));
    let router = Router::new()
        .route(
            "/",
            get(move || {
                let (held, counted) = (Arc::clone(&held), Arc::clone(&counted));
                async move {
                    let _permit = held.acquire().await.unwrap();
                    assert!(
                        counted.fetch_add(1, Ordering::SeqCst) > 0,
                        "PRIVATE_SENTINEL"
                    );
                    "ok"
                }
            }),
        )
        .layer(middleware::from_fn(contained));
    let request = || Request::get("/").body(Body::empty()).unwrap();
    let failed = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(failed.status(), 500);
    let body = axum::body::to_bytes(failed.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(&body[..], br#"{"detail":"Internal Server Error"}"#);
    assert_eq!(permits.available_permits(), 1);
    let answered = router.oneshot(request()).await.unwrap();
    assert_eq!(answered.status(), 200);
}
