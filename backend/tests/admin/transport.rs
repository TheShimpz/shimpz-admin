//! The Team transport: the bearer Team rotates, the NDJSON chat stream's exact framing, and the request a JSON body's
//! assertion binds.

use admin_backend::{
    fault::Reply,
    json::{self, Value},
    team::transport::Options,
};

use crate::support::{Admin, team::Answer};

fn progress(seq: i64) -> Value {
    json::object(vec![
        ("type", json::text("progress")),
        ("seq", json::int(seq)),
        ("phase", json::text("model")),
        ("state", json::text("started")),
    ])
}

#[tokio::test]
async fn a_stream_delivers_its_progress_in_order_then_its_terminal() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.team.script(|request| {
        (request.path == "/v1/teams/marketing/chat").then(|| {
            Answer::Stream(
                vec![progress(1), progress(2)],
                200,
                json::object(vec![("reply", json::text("hi"))]),
            )
        })
    });
    let team = admin.app.session_team(&cookie).unwrap();
    let seen = std::sync::Mutex::new(Vec::new());
    let sink = |event: Value| seen.lock().unwrap().push(event);
    let reply = team
        .call_stream(
            "POST",
            "/v1/teams/marketing/chat",
            &json::empty(),
            Options::default(),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(
        reply,
        Reply::ok(json::object(vec![("reply", json::text("hi"))]))
    );
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(json::get(&seen[1], "seq"), Some(&json::int(2)));
}

#[tokio::test]
async fn a_stream_out_of_order_is_an_unavailable_team() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin.team.script(|request| {
        (request.path == "/v1/teams/marketing/chat")
            .then(|| Answer::Stream(vec![progress(2)], 200, json::empty()))
    });
    let team = admin.app.session_team(&cookie).unwrap();
    let reply = team
        .call_stream(
            "POST",
            "/v1/teams/marketing/chat",
            &json::empty(),
            Options::default(),
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(reply, Reply::detail(502, "team unavailable"));
}

#[tokio::test]
async fn a_refused_bearer_is_read_again_once_and_the_request_resent() {
    let admin = Admin::start().await;
    admin.team.on(
        "GET",
        "/v1/teams",
        200,
        json::object(vec![("teams", Value::Array(Vec::new()))]),
    );
    std::fs::write(&admin.app.config.team_token_file, "stale-bearer").unwrap();
    let team = admin.app.machine_team();
    assert_eq!(
        team.call("GET", "/v1/teams", None).await.unwrap().status,
        502
    );
    std::fs::write(&admin.app.config.team_token_file, "team-bearer-token\n").unwrap();
    assert_eq!(
        team.call("GET", "/v1/teams", None).await.unwrap().status,
        200
    );
}

#[tokio::test]
async fn a_json_body_is_sent_compact_and_bound_by_its_digest() {
    let admin = Admin::start().await;
    let cookie = admin.signed_in();
    admin
        .team
        .on("PATCH", "/v1/teams/marketing", 200, json::empty());
    let team = admin.app.session_team(&cookie).unwrap();
    let body = json::object(vec![("team_name", json::text("Márketing"))]);
    team.call("PATCH", "/v1/teams/marketing", Some(&body))
        .await
        .unwrap();
    let recorded = &admin.team.requests_to("/v1/teams/marketing")[0];
    assert_eq!(recorded.json(), body);
    assert_eq!(
        String::from_utf8(recorded.body.clone()).unwrap(),
        "{\"team_name\":\"Márketing\"}"
    );
    let claims = recorded.assertion.clone().unwrap().unwrap();
    assert_eq!(
        json::get_str(json::get(&claims, "body").unwrap(), "kind"),
        Some("json")
    );
}
