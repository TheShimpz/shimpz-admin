//! A session's lifetime: it idles out after an hour that no HTTP request renews, it never outlives its day, a logout
//! ends every socket of every session, and concurrent setups resume one enrollment.

use admin_backend::json::{self, Value};

use crate::support::{
    Admin, ORIGIN, PASSWORD,
    signin::{body, enrollment_secret, post, sign_up, signed},
    socket::{connect, next},
};

async fn authenticated(admin: &Admin, session: &str) -> bool {
    let view = signed(admin, "/api/session", ORIGIN, session, &json::empty())
        .await
        .json();
    view.get("authenticated") == Some(&Value::Bool(true))
}

#[tokio::test]
async fn no_http_request_renews_a_session_and_it_idles_out_after_an_hour() {
    let admin = Admin::start().await;
    let session = sign_up(&admin, ORIGIN).await.session;
    admin.clock.advance(3599);
    assert!(authenticated(&admin, &session).await);
    let gated = signed(
        &admin,
        "/api/admin/passkeys/registration",
        ORIGIN,
        &session,
        &json::empty(),
    )
    .await;
    assert_eq!(gated.status, 409);
    admin.clock.advance(2);
    assert!(!authenticated(&admin, &session).await);
}

#[tokio::test]
async fn a_session_never_outlives_its_day_whatever_its_activity() {
    let admin = Admin::start().await;
    let session = sign_up(&admin, ORIGIN).await.session;
    for _ in 0..24 {
        admin.clock.advance(3599);
        assert!(
            admin
                .app
                .session_evidence(&session, true)
                .unwrap()
                .is_some()
        );
    }
    admin.clock.advance(25);
    assert!(
        admin
            .app
            .session_evidence(&session, true)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_logout_closes_every_socket_as_signed_out() {
    let admin = Admin::start().await;
    let session = sign_up(&admin, ORIGIN).await.session;
    let cookie = format!("shimpz_admin={session}");
    let headers = [
        ("origin", ORIGIN),
        ("sec-fetch-site", "same-origin"),
        ("sec-websocket-protocol", "shimpz.admin.v1"),
        ("cookie", cookie.as_str()),
    ];
    let mut socket = connect(&admin.url, "/api/session/ws", &headers)
        .await
        .unwrap();
    next(&mut socket).await.unwrap();
    let out = signed(&admin, "/api/logout", ORIGIN, &session, &json::empty()).await;
    assert_eq!(out.status, 200);
    assert_eq!(next(&mut socket).await.err(), Some(4401));
}

#[tokio::test]
async fn concurrent_setups_resume_one_enrollment() {
    let admin = Admin::start().await;
    let payload = body("password", json::text(PASSWORD));
    let setup = || post(&admin, "/api/admin/setup", Some(ORIGIN), &[], &payload);
    let (first, second) = tokio::join!(setup(), setup());
    assert_eq!((first.status, second.status), (202, 202));
    assert_eq!(enrollment_secret(&first), enrollment_secret(&second));
    let events = crate::support::signin::events(&admin);
    assert_eq!(events, ["setup-started"]);
}
