//! Durable chat turns (ADR-0125; plan B0 and B3): a turn is kept from before its dispatch until Team settles it, an
//! Admin restart sends it again under its original session and commits its reply once, a Team that cannot be reached
//! leaves it waiting instead of failed, and a session that ended while the turn waited ends it, whatever later login.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use admin_backend::json;

use crate::{
    chat::{KEY, message, open, parsed, script_team, traced, until},
    support::{
        Admin,
        session::eventually,
        socket::{Socket, send_frame},
        team::Answer,
    },
};

const CHAT: &str = "/v1/teams/marketing/chat";
const REPLY: &str = r#"{"team_id":"marketing","team_name":"Marketing","reply":"Two zones are active.","clarification":null}"#;

/// Team answers the turn's first `hung` sends never, the next ones with `first` until it answers with the reply.
fn script_sends(admin: &Admin, hung: usize, first: Option<Answer>) {
    let sends = Arc::new(AtomicUsize::new(0));
    let first = std::sync::Mutex::new(first);
    admin.team.script(move |request| {
        (request.method == "POST" && request.path == CHAT).then(|| {
            let send = sends.fetch_add(1, Ordering::SeqCst);
            if send < hung {
                return Answer::Hang;
            }
            first
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Answer::Stream(Vec::new(), 200, traced(parsed(REPLY))))
        })
    });
    for route in ["delivered", "revoked"] {
        admin.team.on(
            "POST",
            &format!("/v1/teams/marketing/chat/{route}"),
            200,
            traced(parsed(r#"{"team_id":"marketing","settled":true}"#)),
        );
    }
}

/// Signs in, scripts Team, and attaches a page to the Team's chat: the page and its session cookie.
async fn attached(admin: &Admin) -> (Socket, String) {
    let cookie = admin.signed_in();
    admin.app.store.set_model_api_key("openai", KEY).unwrap();
    script_team(admin);
    let mut socket = open(admin, &cookie).await;
    let params = json::object(vec![
        ("team_id", json::text("marketing")),
        ("locale", json::text("en")),
    ]);
    let call = json::object(vec![
        ("type", json::text("call")),
        ("id", json::text("attach")),
        ("method", json::text("chat.attach")),
        ("params", params),
    ]);
    send_frame(&mut socket, &call).await;
    until(&mut socket, "result").await;
    until(&mut socket, "sync-empty").await;
    (socket, cookie)
}

fn texts(admin: &Admin) -> Vec<String> {
    let page = admin
        .app
        .domains
        .history
        .store
        .page("marketing", None, None)
        .unwrap();
    json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .filter_map(|entry| json::get_str(entry, "text").map(str::to_owned))
        .collect()
}

fn authority(request: &crate::support::team::Recorded) -> String {
    let claims = request.assertion.clone().unwrap().unwrap();
    json::get_str(&claims, "authority_sha256")
        .unwrap()
        .to_owned()
}

/// Whether Admin still keeps a turn.
fn kept(admin: &Admin) -> bool {
    std::fs::read_to_string(admin.app.config.store_path.with_file_name("turns.json"))
        .is_ok_and(|turns| turns.contains("\"nonce\""))
}

#[tokio::test]
async fn a_turn_is_kept_until_team_settles_it_and_then_forgotten() {
    let admin = Admin::start().await;
    let (mut socket, _) = attached(&admin).await;
    script_sends(&admin, 0, None);
    send_frame(&mut socket, &message("List my DNS zones")).await;
    let done = until(&mut socket, "done").await;
    assert_eq!(json::get_str(&done, "reply"), Some("Two zones are active."));
    let sent = admin.team.requests_to(CHAT);
    assert!(
        eventually(|| !admin
            .team
            .requests_to("/v1/teams/marketing/chat/delivered")
            .is_empty())
        .await
    );
    let delivered = admin.team.requests_to("/v1/teams/marketing/chat/delivered");
    // Team is told exactly which send was delivered, under the session that sent it.
    assert_eq!(
        json::get(&delivered[0].json(), "request"),
        json::get(&sent[0].json(), "request")
    );
    assert_eq!(authority(&delivered[0]), authority(&sent[0]));
    assert!(eventually(|| !kept(&admin)).await);
}

#[tokio::test]
async fn an_admin_restart_sends_the_kept_turn_again_under_its_session_and_commits_its_reply_once() {
    let admin = Admin::start().await;
    let (mut socket, _) = attached(&admin).await;
    script_sends(&admin, 1, None);
    send_frame(&mut socket, &message("List my DNS zones")).await;
    assert!(eventually(|| !admin.team.requests_to(CHAT).is_empty()).await);
    // Admin dies while Team runs the turn; its sessions die with it.
    drop(socket);
    let admin = admin.restarted().await;
    admin_backend::chat::durable::reattach::sweep(&admin.app).await;
    let sends = admin.team.requests_to(CHAT);
    assert_eq!(sends.len(), 2);
    // The same send, byte for byte, under the session that sent it, with the provider key Admin holds now.
    assert_eq!(sends[1].body, sends[0].body);
    assert_eq!(authority(&sends[1]), authority(&sends[0]));
    assert_eq!(sends[1].headers.get("x-shimpz-model-api-key").unwrap(), KEY);
    assert_eq!(
        texts(&admin),
        ["List my DNS zones", "Two zones are active."]
    );
    assert!(eventually(|| !kept(&admin)).await);
    // A sweep after it sends nothing again: the reply is committed once.
    admin_backend::chat::durable::reattach::sweep(&admin.app).await;
    assert_eq!(admin.team.requests_to(CHAT).len(), 2);
    assert_eq!(
        texts(&admin),
        ["List my DNS zones", "Two zones are active."]
    );
}

#[tokio::test]
async fn a_logout_while_the_turn_waited_ends_it_and_no_later_login_revives_it() {
    let admin = Admin::start().await;
    let (mut socket, cookie) = attached(&admin).await;
    script_sends(&admin, 1, None);
    send_frame(&mut socket, &message("List my DNS zones")).await;
    assert!(eventually(|| !admin.team.requests_to(CHAT).is_empty()).await);
    drop(socket);
    // The person logs out, then signs in again, before the turn's Team answers.
    admin_backend::chat::durable::revoke_token(&admin.app, &cookie);
    let admin = admin.restarted().await;
    let _again = admin.session();
    admin_backend::chat::durable::reattach::sweep(&admin.app).await;
    // Nothing of the turn is sent again: Team is told it was revoked, and the history keeps it as failed.
    assert_eq!(admin.team.requests_to(CHAT).len(), 1);
    let revoked = admin.team.requests_to("/v1/teams/marketing/chat/revoked");
    assert_eq!(revoked.len(), 1);
    assert_eq!(texts(&admin), ["List my DNS zones"]);
    assert!(eventually(|| !kept(&admin)).await);
}

#[tokio::test]
async fn a_team_that_cannot_be_reached_leaves_the_turn_waiting_until_it_answers() {
    let admin = Admin::start().await;
    let (mut socket, _) = attached(&admin).await;
    let unreachable = Answer::Json(502, json::detail("team unavailable"));
    script_sends(&admin, 0, Some(unreachable));
    send_frame(&mut socket, &message("List my DNS zones")).await;
    let done = tokio::time::timeout(Duration::from_secs(20), until(&mut socket, "done"))
        .await
        .unwrap();
    assert_eq!(json::get_str(&done, "reply"), Some("Two zones are active."));
    let sends = admin.team.requests_to(CHAT);
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[1].body, sends[0].body);
    assert_eq!(
        texts(&admin),
        ["List my DNS zones", "Two zones are active."]
    );
}
