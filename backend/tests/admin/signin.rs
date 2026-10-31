//! The sign-in ceremonies over HTTP: setup and its enrollment, the password step and its lockout, one-use tickets
//! bound to their origin and factors, recovery codes, logout, passkey registration, the fail-closed journal, and the
//! password recovery state; secrets never reach a journal line or an answer that does not show them by design.

use admin_backend::{
    fsio,
    json::{self, Value},
};

use crate::support::{
    Admin, ORIGIN, PASSWORD,
    client::Answer,
    signin::{
        body, code, cookie, enrollment_secret, events, journal, password_step, post, set_cookies,
        sign_up, signed, with_ticket,
    },
};

const EXTERNAL: &str = "https://admin.example.org";
const LOCALHOST: &str = "http://localhost:7777";
const WRONG: &str = "wrong password but long enough";

async fn view(admin: &Admin, origin: &str, session: &str) -> Value {
    signed(admin, "/api/session", origin, session, &json::empty())
        .await
        .json()
}

async fn setup_step(admin: &Admin, origin: &str, password: &str) -> Answer {
    post(
        admin,
        "/api/admin/setup",
        Some(origin),
        &[],
        &body("password", json::text(password)),
    )
    .await
}

fn authenticated(view: &Value) -> bool {
    view.get("authenticated") == Some(&Value::Bool(true))
}

#[tokio::test]
async fn setup_issues_strict_cookies() {
    let admin = Admin::start().await;
    let started = setup_step(&admin, ORIGIN, PASSWORD).await;
    assert_eq!(started.header("cache-control"), Some("no-store"));
    let ticket = cookie(&started, "shimpz_admin_ticket").unwrap();
    let expected =
        format!("shimpz_admin_ticket={ticket}; HttpOnly; Max-Age=180; Path=/api/; SameSite=strict");
    assert_eq!(set_cookies(&started), [expected]);
    let secret = enrollment_secret(&started);
    let confirmed = with_ticket(
        &admin,
        "/api/admin/setup/totp",
        ORIGIN,
        &ticket,
        &code(&admin, &secret),
    )
    .await;
    let session = cookie(&confirmed, "shimpz_admin").unwrap();
    let deleted = "shimpz_admin_ticket=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/api/; SameSite=lax";
    let issued =
        format!("shimpz_admin={session}; HttpOnly; Max-Age=86400; Path=/; SameSite=strict");
    assert_eq!(set_cookies(&confirmed), [issued, deleted.to_owned()]);
    let view = view(&admin, ORIGIN, &session).await;
    assert!(authenticated(&view));
    assert_eq!(json::get_str(&view, "authentication_method"), Some("totp"));
    assert_eq!(
        json::get_str(&view, "oauth_completion_mode"),
        Some("automatic")
    );
    assert_eq!(
        view.get("passkey_enrollment_available"),
        Some(&Value::Bool(false))
    );
}

#[tokio::test]
async fn setup_journals_each_step_without_a_secret() {
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    assert_eq!(signed_up.codes.len(), 10);
    assert_eq!(events(&admin), ["setup-started", "setup-completed"]);
    let lines = std::fs::read_to_string(admin.app.config.audit_path()).unwrap();
    let stored = std::fs::read_to_string(&admin.app.config.store_path).unwrap();
    let shown = &signed_up.codes[0];
    // The store keeps the TOTP secret it verifies against, never the password or a recovery code.
    assert!(
        !lines.contains(PASSWORD) && !lines.contains(&signed_up.secret) && !lines.contains(shown)
    );
    assert!(!stored.contains(PASSWORD) && !stored.contains(shown));
}

#[tokio::test]
async fn an_external_origin_is_learned_only_after_the_second_factor_and_marks_cookies_secure() {
    let admin = Admin::start().await;
    let started = setup_step(&admin, EXTERNAL, PASSWORD).await;
    assert!(set_cookies(&started)[0].ends_with("; SameSite=strict; Secure"));
    assert_eq!(admin.app.store.browser_origin().unwrap(), None);
    let ticket = cookie(&started, "shimpz_admin_ticket").unwrap();
    let secret = enrollment_secret(&started);
    let confirmed = with_ticket(
        &admin,
        "/api/admin/setup/totp",
        EXTERNAL,
        &ticket,
        &code(&admin, &secret),
    )
    .await;
    assert!(set_cookies(&confirmed)[0].ends_with("; Secure"));
    assert_eq!(
        admin.app.store.browser_origin().unwrap().as_deref(),
        Some(EXTERNAL)
    );
    assert!(events(&admin).contains(&"origin-learned".to_owned()));
    let session = cookie(&confirmed, "shimpz_admin").unwrap();
    assert_eq!(
        json::get_str(
            &view(&admin, EXTERNAL, &session).await,
            "oauth_completion_mode"
        ),
        Some("code")
    );
    let refused = password_step(&admin, "http://admin.example.org", PASSWORD)
        .await
        .0;
    assert_eq!(
        (refused.status, refused.json()),
        (403, json::detail("request Origin is not admitted"))
    );
}

#[tokio::test]
async fn wrong_passwords_are_journaled_and_lock_every_password_step() {
    let admin = Admin::start().await;
    sign_up(&admin, ORIGIN).await;
    for _ in 0..4 {
        let (answer, ticket) = password_step(&admin, ORIGIN, WRONG).await;
        assert_eq!((answer.status, ticket), (401, None));
        assert_eq!(
            answer.json(),
            json::detail("invalid Supervisor credentials")
        );
    }
    let (locked, _) = password_step(&admin, ORIGIN, WRONG).await;
    assert_eq!(
        (locked.status, locked.header("retry-after")),
        (429, Some("60"))
    );
    assert_eq!(password_step(&admin, ORIGIN, PASSWORD).await.0.status, 429);
    let journaled = events(&admin);
    assert_eq!(
        journaled
            .iter()
            .filter(|event| *event == "password-rejected")
            .count(),
        4
    );
    assert_eq!(
        journaled
            .iter()
            .filter(|event| *event == "password-locked")
            .count(),
        1
    );
    let entry = journal(&admin).into_iter().last().unwrap();
    assert_eq!(json::get_str(&entry, "origin"), Some(ORIGIN));
    admin.clock.advance(60);
    let (answer, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    assert_eq!(answer.status, 202);
    assert!(ticket.is_some());
}

#[tokio::test]
async fn a_ticket_is_spent_by_any_presentation() {
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    admin.clock.advance(30);
    let (answer, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    let methods = json::get(&answer.json(), "methods").cloned();
    assert_eq!(methods, Some(json::strings(["totp", "recovery-code"])));
    let ticket = ticket.unwrap();
    let wrong = with_ticket(&admin, "/api/login/totp", ORIGIN, &ticket, "000000").await;
    assert_eq!(
        (wrong.status, wrong.json()),
        (401, json::detail("invalid verification code"))
    );
    let right = code(&admin, &signed_up.secret);
    let spent = with_ticket(&admin, "/api/login/totp", ORIGIN, &ticket, &right).await;
    let expired = json::detail("authentication ceremony expired; enter the password again");
    assert_eq!((spent.status, spent.json()), (401, expired));
    let (_, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    let signed_in = with_ticket(&admin, "/api/login/totp", ORIGIN, &ticket.unwrap(), &right).await;
    let ok = json::object(vec![
        ("ok", Value::Bool(true)),
        ("method", json::text("totp")),
    ]);
    assert_eq!(signed_in.json(), ok);
    assert!(events(&admin).ends_with(&["totp-rejected".to_owned(), "login".to_owned()]));
}

#[tokio::test]
async fn a_ticket_is_bound_to_its_origin_and_its_factors() {
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    admin.clock.advance(30);
    let right = code(&admin, &signed_up.secret);
    let (_, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    let moved = with_ticket(
        &admin,
        "/api/login/totp",
        LOCALHOST,
        &ticket.unwrap(),
        &right,
    )
    .await;
    let changed_origin = json::detail("authentication ceremony origin changed");
    assert_eq!((moved.status, moved.json()), (403, changed_origin));
    let (_, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    let codes = admin_backend::signin::recovery::new_set();
    admin
        .app
        .store
        .replace_recovery_codes(&codes.record, &|()| Ok(()))
        .unwrap();
    let changed = with_ticket(&admin, "/api/login/totp", ORIGIN, &ticket.unwrap(), &right).await;
    assert_eq!(changed.status, 409);
}

#[tokio::test]
async fn setup_names_its_password_policy_and_is_refused_once_configured() {
    let admin = Admin::start().await;
    let weak = setup_step(&admin, ORIGIN, "short").await;
    assert_eq!(
        (weak.status, weak.header("cache-control")),
        (400, Some("no-store"))
    );
    assert_eq!(
        json::get_str(&weak.json(), "code"),
        Some("password-too-short")
    );
    let extra = json::object(vec![
        ("password", json::text(PASSWORD)),
        ("x", json::int(1)),
    ]);
    let shaped = post(&admin, "/api/admin/setup", Some(ORIGIN), &[], &extra).await;
    assert_eq!(
        shaped.json(),
        json::detail("request body must contain only password")
    );
    assert_eq!(events(&admin), Vec::<String>::new());
    let early = password_step(&admin, ORIGIN, PASSWORD).await.0;
    let incomplete = json::detail("Local Supervisor MFA setup is incomplete");
    assert_eq!((early.status, early.json()), (409, incomplete));
    sign_up(&admin, ORIGIN).await;
    assert_eq!(setup_step(&admin, ORIGIN, PASSWORD).await.status, 409);
}

async fn recovery_step(admin: &Admin, recovery_code: &str) -> Answer {
    let (_, ticket) = password_step(admin, ORIGIN, PASSWORD).await;
    with_ticket(
        admin,
        "/api/login/recovery",
        ORIGIN,
        &ticket.unwrap(),
        recovery_code,
    )
    .await
}

#[tokio::test]
async fn a_recovery_code_replaces_totp_and_ends_every_session() {
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    let used = recovery_step(&admin, &signed_up.codes[0]).await;
    assert_eq!(used.status, 202);
    assert!(!authenticated(
        &view(&admin, ORIGIN, &signed_up.session).await
    ));
    let ticket = cookie(&used, "shimpz_admin_ticket").unwrap();
    let secret = enrollment_secret(&used);
    let mistyped = with_ticket(
        &admin,
        "/api/login/recovery/totp",
        ORIGIN,
        &ticket,
        "000000",
    )
    .await;
    assert_eq!(mistyped.status, 401);
    let ticket = cookie(&mistyped, "shimpz_admin_ticket").unwrap();
    let path = "/api/login/recovery/totp";
    let enrolled = with_ticket(&admin, path, ORIGIN, &ticket, &code(&admin, &secret)).await;
    assert_eq!(enrolled.status, 200);
    assert!(cookie(&enrolled, "shimpz_admin").is_some());
    let tail = ["recovery-code-used", "totp-rejected", "recovery-completed"].map(str::to_owned);
    assert!(events(&admin).ends_with(&tail));
    assert_eq!(recovery_step(&admin, &signed_up.codes[0]).await.status, 401);
}

#[tokio::test]
async fn an_unwritable_journal_refuses_sign_in_as_unavailable_and_is_never_cached() {
    use std::os::unix::fs::PermissionsExt;
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    admin.clock.advance(30);
    let (_, ticket) = password_step(&admin, ORIGIN, PASSWORD).await;
    let mode = std::fs::Permissions::from_mode(0o644);
    std::fs::set_permissions(admin.app.config.audit_path(), mode).unwrap();
    let right = code(&admin, &signed_up.secret);
    let refused = with_ticket(&admin, "/api/login/totp", ORIGIN, &ticket.unwrap(), &right).await;
    assert_eq!(refused.status, 503);
    assert_eq!(
        refused.json(),
        json::detail("Supervisor authentication audit is unavailable")
    );
    assert_eq!(refused.header("cache-control"), Some("no-store"));
    assert_eq!(cookie(&refused, "shimpz_admin"), None);
    assert_eq!(password_step(&admin, ORIGIN, WRONG).await.0.status, 503);
}

#[tokio::test]
async fn a_password_record_that_needs_recovery_is_reported_by_every_ceremony() {
    let admin = Admin::start().await;
    sign_up(&admin, ORIGIN).await;
    let mut data = admin.app.store.get().unwrap();
    json::set(
        &mut data,
        "password_verifier",
        json::text("scrypt-v1$broken"),
    );
    let store = &admin.app.config.store_path;
    fsio::replace_atomically(store, json::indented(&data).as_bytes()).unwrap();
    let view = post(&admin, "/api/session", Some(ORIGIN), &[], &json::empty())
        .await
        .json();
    assert_eq!(
        json::get_str(&view, "authentication_state"),
        Some("recovery-required")
    );
    let login = password_step(&admin, ORIGIN, PASSWORD).await.0;
    assert_eq!(login.status, 503);
    assert_eq!(
        json::get_str(&login.json(), "code"),
        Some("password-recovery-required")
    );
}

#[tokio::test]
async fn logout_from_admin_s_page_journals_and_ends_every_session() {
    let admin = Admin::start().await;
    let signed_up = sign_up(&admin, ORIGIN).await;
    let session = signed_up.session.as_str();
    let other = signed(
        &admin,
        "/api/logout",
        "https://evil.example",
        session,
        &json::empty(),
    )
    .await;
    assert_eq!(
        (other.status, other.json()),
        (403, json::detail("logout origin is not admitted"))
    );
    let out = signed(&admin, "/api/logout", ORIGIN, session, &json::empty()).await;
    assert_eq!(out.json(), json::object(vec![("ok", Value::Bool(true))]));
    assert!(set_cookies(&out)[0].starts_with("shimpz_admin=\"\"; expires="));
    assert_eq!(events(&admin).last().map(String::as_str), Some("logout"));
    assert!(!authenticated(&view(&admin, ORIGIN, session).await));
}

#[tokio::test]
async fn passkey_registration_needs_an_empty_body_and_a_webauthn_origin() {
    let admin = Admin::start().await;
    let session = sign_up(&admin, LOCALHOST).await.session;
    let path = "/api/admin/passkeys/registration";
    let shaped = signed(&admin, path, LOCALHOST, &session, &body("x", json::int(1))).await;
    assert_eq!(
        shaped.json(),
        json::detail("request body must be an empty object")
    );
    let begun = signed(&admin, path, LOCALHOST, &session, &json::empty()).await;
    assert_eq!(begun.status, 200);
    let options = json::get(&begun.json(), "options").cloned().unwrap();
    assert_eq!(
        json::get(&options, "rp").and_then(|rp| json::get_str(rp, "id")),
        Some("localhost")
    );
    assert_eq!(
        signed(&admin, path, ORIGIN, &session, &json::empty())
            .await
            .status,
        409
    );
}

#[tokio::test]
async fn passkey_registration_needs_fresh_mfa_and_refuses_an_unverified_response() {
    let admin = Admin::start().await;
    let session = sign_up(&admin, LOCALHOST).await.session;
    let path = "/api/admin/passkeys/registration";
    assert_eq!(
        signed(&admin, path, LOCALHOST, &session, &json::empty())
            .await
            .status,
        200
    );
    let credential = json::object(vec![
        ("id", json::text("AAAA")),
        ("type", json::text("public-key")),
    ]);
    let completed = signed(
        &admin,
        "/api/admin/passkeys",
        LOCALHOST,
        &session,
        &body("credential", credential),
    )
    .await;
    assert_eq!(
        (completed.status, completed.json()),
        (400, json::detail("invalid passkey registration"))
    );
    admin.clock.advance(301);
    let stale = signed(&admin, path, LOCALHOST, &session, &json::empty()).await;
    let fresh = json::detail("fresh multifactor authentication is required");
    assert_eq!((stale.status, stale.json()), (401, fresh));
}

#[tokio::test]
async fn an_abandoned_password_check_keeps_its_permit_and_records_its_refusal() {
    let admin = Admin::start().await;
    admin.signed_in();
    let app = std::sync::Arc::clone(&admin.app);
    let wrong = admin_backend::json::text("wrong horse battery staple x");
    let check = admin_backend::signin::local::check_password(&app, &wrong, None);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(1), check)
            .await
            .is_err()
    );
    assert!(
        app.limiter.begin().is_err(),
        "the derivation still holds its permit"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while app.limiter.begin().is_err() {
        assert!(
            std::time::Instant::now() < deadline,
            "the permit was never released"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // The task journals the refusal right after the limiter accounts for it and frees the permit.
    while !std::fs::read_to_string(app.config.audit_path())
        .is_ok_and(|journal| journal.contains("\"password-rejected\""))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the refusal was never journaled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
