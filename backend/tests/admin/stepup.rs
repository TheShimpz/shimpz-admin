//! The Supervisor's confirmed operations over the session socket: the password within sign-in's lockout and journal,
//! then exactly one second factor that spends a ticket bound to the operation and the socket; the security summary;
//! and the signing key rotation Team settles.

use admin_backend::{
    json::{self, Value},
    signin::totp,
};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use sha2::{Digest, Sha256};

use crate::support::{
    Admin, ORIGIN, PASSWORD,
    signin::events,
    socket::{Socket, connect, next, send_frame},
    team::Answer,
};

const WRONG: &str = "wrong password but long enough";

async fn open(admin: &Admin, cookie: &str) -> Socket {
    let cookie = format!("shimpz_admin={cookie}");
    let headers = [
        ("origin", ORIGIN),
        ("sec-fetch-site", "same-origin"),
        ("sec-websocket-protocol", "shimpz.admin.v1"),
        ("cookie", cookie.as_str()),
    ];
    let mut socket = connect(&admin.url, "/api/session/ws", &headers)
        .await
        .unwrap();
    assert_eq!(
        json::get_str(&next(&mut socket).await.unwrap(), "type"),
        Some("session")
    );
    socket
}

/// One call's status and body.
async fn call(socket: &mut Socket, method: &str, body: Value) -> (i64, Value) {
    let id = format!("c{}", admin_backend::random::hex(4));
    let frame = json::object(vec![
        ("type", json::text("call")),
        ("id", json::text(&id)),
        ("method", json::text(method)),
        (
            "params",
            if body == Value::Null {
                json::empty()
            } else {
                json::object(vec![("body", body)])
            },
        ),
    ]);
    send_frame(socket, &frame).await;
    loop {
        let answer = next(socket).await.unwrap();
        if json::get_str(&answer, "id") == Some(id.as_str()) {
            let status = json::get(&answer, "status").and_then(json::as_int).unwrap();
            return (status, json::get(&answer, "body").cloned().unwrap());
        }
    }
}

fn password(text: &str) -> Value {
    json::object(vec![("password", json::text(text))])
}

fn code(admin: &Admin) -> Value {
    let data = admin.app.store.get().unwrap();
    let secret = json::get_str(json::get(&data, "totp").unwrap(), "secret")
        .unwrap()
        .to_owned();
    json::object(vec![(
        "code",
        json::text(totp::code_at(&secret, admin.clock.now_secs())),
    )])
}

fn refusal(code: &str) -> Value {
    json::code(code)
}

async fn signed_in() -> (Admin, Socket) {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.clock.advance(30);
    let socket = open(&admin, &cookie).await;
    (admin, socket)
}

#[tokio::test]
async fn replacing_the_recovery_codes_needs_the_password_and_a_second_factor() {
    let (admin, mut socket) = signed_in().await;
    let offered = call(
        &mut socket,
        "recovery_codes.confirmation",
        password(PASSWORD),
    )
    .await;
    let methods = json::object(vec![("methods", json::strings(["totp"]))]);
    assert_eq!(offered, (202, methods));
    let (status, replaced) = call(&mut socket, "recovery_codes.replace", code(&admin)).await;
    assert_eq!(status, 200);
    let codes = json::get(&replaced, "recovery_codes")
        .and_then(json::as_array)
        .unwrap();
    assert_eq!(codes.len(), 10);
    let tail = ["operation-confirmed", "recovery-codes-generated"].map(str::to_owned);
    assert!(events(&admin).ends_with(&tail));
}

#[tokio::test]
async fn wrong_passwords_share_the_sign_in_lockout_and_journal_with_the_socket_s_origin() {
    let (admin, mut socket) = signed_in().await;
    for _ in 0..4 {
        let refused = call(&mut socket, "supervisor_key.confirmation", password(WRONG)).await;
        assert_eq!(refused, (401, refusal("password-incorrect")));
    }
    let locked = call(&mut socket, "supervisor_key.confirmation", password(WRONG)).await;
    let expected = json::object(vec![
        ("code", json::text("authentication-locked")),
        ("retry_after", json::int(60)),
    ]);
    assert_eq!(locked, (429, expected));
    let line = crate::support::signin::journal(&admin)
        .into_iter()
        .last()
        .unwrap();
    assert_eq!(json::get_str(&line, "event"), Some("password-locked"));
    assert_eq!(json::get_str(&line, "origin"), Some(ORIGIN));
}

#[tokio::test]
async fn a_wrong_code_spends_the_ticket_and_no_ticket_confirms_nothing() {
    let (admin, mut socket) = signed_in().await;
    let expired = (401, refusal("authentication-expired"));
    assert_eq!(
        call(&mut socket, "recovery_codes.replace", code(&admin)).await,
        expired
    );
    call(
        &mut socket,
        "recovery_codes.confirmation",
        password(PASSWORD),
    )
    .await;
    let wrong = json::object(vec![("code", json::text("000000"))]);
    let refused = call(&mut socket, "recovery_codes.replace", wrong).await;
    assert_eq!(refused, (401, refusal("code-incorrect")));
    assert_eq!(
        call(&mut socket, "recovery_codes.replace", code(&admin)).await,
        expired
    );
}

#[tokio::test]
async fn a_ticket_for_one_operation_never_completes_another() {
    let (admin, mut socket) = signed_in().await;
    call(
        &mut socket,
        "recovery_codes.confirmation",
        password(PASSWORD),
    )
    .await;
    let other = call(&mut socket, "supervisor_key.rotate", code(&admin)).await;
    assert_eq!(other, (401, refusal("authentication-expired")));
    assert_eq!(admin.team.requests().len(), 0);
}

#[tokio::test]
async fn bad_bodies_are_refused_before_the_ticket_is_spent() {
    let (admin, mut socket) = signed_in().await;
    let shaped = call(&mut socket, "recovery_codes.confirmation", json::empty()).await;
    assert_eq!(
        shaped,
        (400, json::detail("request body must contain only password"))
    );
    call(
        &mut socket,
        "recovery_codes.confirmation",
        password(PASSWORD),
    )
    .await;
    let factor = call(
        &mut socket,
        "recovery_codes.replace",
        json::object(vec![("x", json::int(1))]),
    )
    .await;
    let detail = json::detail("request body must contain only code or credential");
    assert_eq!(factor, (400, detail));
    assert_eq!(
        call(&mut socket, "recovery_codes.replace", code(&admin))
            .await
            .0,
        200
    );
}

#[tokio::test]
async fn a_ticket_belongs_to_its_socket_and_dies_with_it() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.clock.advance(30);
    let mut first = open(&admin, &cookie).await;
    call(
        &mut first,
        "recovery_codes.confirmation",
        password(PASSWORD),
    )
    .await;
    drop(first);
    let mut second = open(&admin, &cookie).await;
    let expired = call(&mut second, "recovery_codes.replace", code(&admin)).await;
    assert_eq!(expired, (401, refusal("authentication-expired")));
}

#[tokio::test]
async fn the_summary_reports_the_codes_left_and_an_acknowledgment_names_a_positive_count() {
    let (_admin, mut socket) = signed_in().await;
    let (status, summary) = call(&mut socket, "security.summary", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(
        json::get(&summary, "recovery_codes_remaining"),
        Some(&json::int(10))
    );
    assert_eq!(
        json::get(&summary, "failed_second_factor_attempts"),
        Some(&json::int(0))
    );
    let refused = call(
        &mut socket,
        "security.acknowledge",
        json::object(vec![("acknowledged", json::int(0))]),
    )
    .await;
    let detail = json::detail("request body must contain only a positive acknowledged count");
    assert_eq!(refused, (400, detail));
}

/// Team pins whatever key it is asked to while `status` is 200.
fn team_pins(admin: &Admin, status: u16) {
    admin.team.script(move |request| {
        (request.path == "/v1/space/supervisor-key").then(|| {
            let key = json::get_str(&request.json(), "public_key")
                .unwrap()
                .to_owned();
            let raw = BASE64URL_NOPAD.decode(key.as_bytes()).unwrap();
            let body = json::object(vec![
                ("rotated", Value::Bool(true)),
                (
                    "key_sha256",
                    json::text(HEXLOWER.encode(&Sha256::digest(&raw))),
                ),
            ]);
            Answer::Json(
                status,
                if status == 200 {
                    body
                } else {
                    json::detail("busy")
                },
            )
        })
    });
}

#[tokio::test]
async fn rotating_the_supervisor_key_needs_the_password_and_a_second_factor() {
    let (admin, mut socket) = signed_in().await;
    team_pins(&admin, 200);
    let earlier = admin.app.store.local_supervisor().unwrap().key_hex();
    call(
        &mut socket,
        "supervisor_key.confirmation",
        password(PASSWORD),
    )
    .await;
    let rotated = call(&mut socket, "supervisor_key.rotate", code(&admin)).await;
    assert_eq!(
        rotated,
        (200, json::object(vec![("rotated", Value::Bool(true))]))
    );
    assert_ne!(
        admin.app.store.local_supervisor().unwrap().key_hex(),
        earlier
    );
    let asked = admin.team.requests_to("/v1/space/supervisor-key");
    assert_eq!(asked.len(), 1);
    assert!(asked[0].assertion.as_ref().is_some_and(Result::is_ok));
    let tail = ["supervisor-key-rotation-started", "supervisor-key-rotated"].map(str::to_owned);
    assert!(events(&admin).ends_with(&tail));
}

#[tokio::test]
async fn a_rotation_team_did_not_answer_stays_open_until_a_retry_settles_it() {
    let (admin, mut socket) = signed_in().await;
    team_pins(&admin, 503);
    let earlier = admin.app.store.local_supervisor().unwrap().key_hex();
    call(
        &mut socket,
        "supervisor_key.confirmation",
        password(PASSWORD),
    )
    .await;
    let pending = call(&mut socket, "supervisor_key.rotate", code(&admin)).await;
    assert_eq!(pending, (503, refusal("supervisor-key-rotation-pending")));
    assert!(admin.app.store.pending_supervisor_key().unwrap().is_some());
    assert_eq!(
        admin.app.store.local_supervisor().unwrap().key_hex(),
        earlier
    );
    team_pins(&admin, 200);
    let settled = admin_backend::space::supervisor_key::resolve(&admin.app, None).await;
    assert_eq!(
        settled,
        Ok(admin_backend::space::supervisor_key::Outcome::Rotated)
    );
    assert!(admin.app.store.pending_supervisor_key().unwrap().is_none());
}
