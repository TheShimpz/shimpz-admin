//! A browser completing the sign-in ceremonies over HTTP, cookie by cookie.

use admin_backend::{
    json::{self, Value},
    signin::totp,
};

use super::{Admin, PASSWORD, client};

/// Every `Set-Cookie` of an answer.
#[must_use]
pub fn set_cookies(answer: &client::Answer) -> Vec<String> {
    answer
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect()
}

/// The value a `Set-Cookie` of the answer gives `name`.
#[must_use]
pub fn cookie(answer: &client::Answer, name: &str) -> Option<String> {
    set_cookies(answer).iter().find_map(|header| {
        let (pair, _) = header.split_once(';').unwrap_or((header, ""));
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

/// `POST path` with a JSON body from `origin`, carrying `cookies`.
pub async fn post(
    admin: &Admin,
    path: &str,
    origin: Option<&str>,
    cookies: &[(&str, &str)],
    body: &Value,
) -> client::Answer {
    let cookie = cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut headers = vec![
        ("content-type", "application/json"),
        ("sec-fetch-site", "same-origin"),
    ];
    if let Some(origin) = origin {
        headers.push(("origin", origin));
    }
    if !cookie.is_empty() {
        headers.push(("cookie", cookie.as_str()));
    }
    client::send(
        &admin.url,
        "POST",
        path,
        &headers,
        json::compact(body).into_bytes(),
    )
    .await
}

/// `{name: value}`.
#[must_use]
pub fn body(name: &str, value: Value) -> Value {
    json::object(vec![(name, value)])
}

/// What a completed setup leaves the browser: its session cookie, the recovery codes, and the TOTP secret.
pub struct SignedUp {
    /// The session cookie value.
    pub session: String,
    /// The recovery codes shown once.
    pub codes: Vec<String>,
    /// The TOTP secret.
    pub secret: String,
}

/// Sets the Supervisor up over HTTP from `origin`.
pub async fn sign_up(admin: &Admin, origin: &str) -> SignedUp {
    let started = post(
        admin,
        "/api/admin/setup",
        Some(origin),
        &[],
        &body("password", json::text(PASSWORD)),
    )
    .await;
    assert_eq!(started.status, 202, "{:?}", started.json());
    let secret = enrollment_secret(&started);
    let ticket = cookie(&started, "shimpz_admin_ticket").unwrap();
    let confirmed = with_ticket(
        admin,
        "/api/admin/setup/totp",
        origin,
        &ticket,
        &code(admin, &secret),
    )
    .await;
    assert_eq!(confirmed.status, 200, "{:?}", confirmed.json());
    let codes = json::as_array(json::get(&confirmed.json(), "recovery_codes").unwrap())
        .unwrap()
        .iter()
        .map(|code| json::as_str(code).unwrap().to_owned())
        .collect();
    SignedUp {
        session: cookie(&confirmed, "shimpz_admin").unwrap(),
        codes,
        secret,
    }
}

/// The password step of a sign-in from `origin`: its answer and its ticket.
pub async fn password_step(
    admin: &Admin,
    origin: &str,
    password: &str,
) -> (client::Answer, Option<String>) {
    let answer = post(
        admin,
        "/api/login",
        Some(origin),
        &[],
        &body("password", json::text(password)),
    )
    .await;
    let ticket = cookie(&answer, "shimpz_admin_ticket");
    (answer, ticket)
}

/// The journal's lines.
#[must_use]
pub fn journal(admin: &Admin) -> Vec<Value> {
    std::fs::read_to_string(admin.app.config.audit_path())
        .unwrap_or_default()
        .lines()
        .map(|line| json::parse(line.as_bytes()).unwrap())
        .collect()
}

/// The journal's event names.
#[must_use]
pub fn events(admin: &Admin) -> Vec<String> {
    journal(admin)
        .iter()
        .map(|entry| json::get_str(entry, "event").unwrap().to_owned())
        .collect()
}

/// `POST path` presenting the ticket cookie `ticket` with `{"code": code}`.
pub async fn with_ticket(
    admin: &Admin,
    path: &str,
    origin: &str,
    ticket: &str,
    code: &str,
) -> client::Answer {
    post(
        admin,
        path,
        Some(origin),
        &[("shimpz_admin_ticket", ticket)],
        &body("code", json::text(code)),
    )
    .await
}

/// `POST path` under the session cookie `session` with `payload`.
pub async fn signed(
    admin: &Admin,
    path: &str,
    origin: &str,
    session: &str,
    payload: &Value,
) -> client::Answer {
    post(
        admin,
        path,
        Some(origin),
        &[("shimpz_admin", session)],
        payload,
    )
    .await
}

/// The enrollment secret a 202 answer shows.
#[must_use]
pub fn enrollment_secret(answer: &client::Answer) -> String {
    json::get_str(json::get(&answer.json(), "enrollment").unwrap(), "secret")
        .unwrap()
        .to_owned()
}

/// The current code of `secret`.
#[must_use]
pub fn code(admin: &Admin, secret: &str) -> String {
    totp::code_at(secret, admin.clock.now_secs())
}
