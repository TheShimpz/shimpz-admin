use std::os::unix::fs::PermissionsExt;

use super::*;

fn store(root: &std::path::Path) -> Store {
    Store::new(
        root.join("chat-history.sqlite3"),
        Arc::new(Clock::new()),
        Arc::new(Topics::new()),
    )
}

fn turn() -> String {
    crate::random::hex(16)
}

fn done(reply: &str) -> Value {
    json::object(vec![
        ("type", json::text("done")),
        ("team_id", json::text("marketing")),
        ("team_name", json::text("Marketing")),
        ("reply", json::text(reply)),
        ("clarification", Value::Null),
    ])
}

fn installed() -> Value {
    json::parse(
        br#"{"type":"assistant-install-plan","state":"installed","plan_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "team_id":"marketing","assistants":[{"id":"shimpz-cloudflare","name":"Shimpz Cloudflare",
        "summary":"Manage DNS records.","creator":"@shimpz","version":"0.4.5","providers":["cloudflare"],
        "provenance":"local","status":"installed"}],"continuation":"dispatch"}"#,
    )
    .unwrap()
}

fn kinds(page: &Value) -> Vec<(String, Option<String>)> {
    json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .map(|entry| {
            (
                json::get_str(entry, "kind").unwrap().to_owned(),
                json::get_str(entry, "text").map(str::to_owned),
            )
        })
        .collect()
}

#[test]
fn terminal_rows_are_idempotent_and_kept_in_presentation_order() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let (first, second) = (turn(), turn());
    let message = json::text("Install Cloudflare");
    let writes = [
        store.append_user("marketing", &first, &message, &[]),
        store.append_user("marketing", &first, &message, &[]),
        store.append_install("marketing", &first, &installed()),
        store.append_install("marketing", &first, &installed()),
        store.append_user("marketing", &second, &json::text("List my DNS zones"), &[]),
        store.append_reply("marketing", &second, &done("Two zones are active."), None),
    ];
    assert!(writes.iter().all(|written| *written == Ok(true)));
    let page = store.page("marketing", None, None).unwrap();
    assert_eq!(page.get("before"), Some(&Value::Null));
    assert_eq!(
        kinds(&page),
        vec![
            ("message".to_owned(), Some("Install Cloudflare".to_owned())),
            ("assistant-install".to_owned(), None),
            ("message".to_owned(), Some("List my DNS zones".to_owned())),
            (
                "message".to_owned(),
                Some("Two zones are active.".to_owned())
            ),
        ]
    );
    let install = &json::as_array(page.get("entries").unwrap()).unwrap()[1];
    assert!(!json::contains(install, "plan_id") && !json::contains(install, "continuation"));
}

#[test]
fn an_ending_without_a_reply_keeps_one_public_line() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let (failed, plain) = (turn(), turn());
    for id in [&failed, &plain] {
        store
            .append_user("marketing", id, &json::text("Read the edital"), &[])
            .unwrap();
    }
    let long = format!("Team   is\nunavailable {}", "x".repeat(400));
    let error = |detail: &str| {
        json::object(vec![
            ("type", json::text("error")),
            ("status", json::int(503)),
            ("detail", json::text(detail)),
        ])
    };
    assert!(
        store
            .append_status("marketing", &failed, &error(&long), false)
            .unwrap()
    );
    assert!(
        store
            .append_status("marketing", &plain, &error("\u{202e}"), false)
            .unwrap()
    );
    let page = store.page("marketing", None, None).unwrap();
    let statuses: Vec<&Value> = json::as_array(page.get("entries").unwrap())
        .unwrap()
        .iter()
        .filter(|entry| json::get_str(entry, "kind") == Some("status"))
        .collect();
    let detail = json::get_str(statuses[0], "detail").unwrap();
    assert!(
        detail.starts_with("Team is unavailable x")
            && detail.chars().count() == MAX_STATUS_DETAIL_CHARS
    );
    assert_eq!(
        json::get_str(statuses[1], "detail"),
        Some("the turn failed")
    );
}

#[test]
fn a_turn_event_after_its_team_was_cleared_is_never_recorded() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let id = turn();
    store
        .append_user("marketing", &id, &json::text("Request"), &[])
        .unwrap();
    assert_eq!(store.clear_team("marketing").unwrap(), 1);
    assert!(
        !store
            .append_reply("marketing", &id, &done("Late reply."), None)
            .unwrap()
    );
    assert_eq!(store.clear_all().unwrap(), 0);
    assert!(
        store.append_reply("sales", &id, &done("x"), None).is_err(),
        "a reply names its own Team"
    );
}

#[test]
fn the_store_is_private_and_another_schema_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    store
        .append_user("marketing", &turn(), &json::text("Request"), &[])
        .unwrap();
    let path = root.path().join("chat-history.sqlite3");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version = 3")
        .unwrap();
    assert_eq!(
        store.page("marketing", None, None),
        Err(HistoryError::Unavailable)
    );
}

#[test]
fn a_cursor_is_canonical_and_within_the_rowid_range() {
    assert_eq!(page::position(&page::cursor(1)), Ok(1));
    assert_eq!(page::position(&page::cursor(i64::MAX)), Ok(i64::MAX));
    for refused in [
        "",
        "AAAAAAAAAAA=",
        "AAAAAAAAAAA",
        "gAAAAAAAAAA",
        "AAAAAAAAAAE=",
        "*",
    ] {
        assert_eq!(
            page::position(refused),
            Err(Invalid("chat history cursor is invalid")),
            "{refused}"
        );
    }
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    assert_eq!(
        store.page("marketing", None, Some("../x")),
        Err(HistoryError::Invalid("chat history Routine id is invalid"))
    );
    assert_eq!(
        store.page("Marketing", None, None),
        Err(HistoryError::Invalid("chat history Team id is invalid"))
    );
}

#[test]
fn a_page_keeps_its_cursor_only_while_an_older_row_exists() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    for index in 0..=PAGE_ROWS {
        store
            .append_user(
                "marketing",
                &turn(),
                &json::text(format!("message {index}")),
                &[],
            )
            .unwrap();
    }
    let page = store.page("marketing", None, None).unwrap();
    assert_eq!(
        json::as_array(page.get("entries").unwrap()).unwrap().len(),
        PAGE_ROWS
    );
    let before = json::get_str(&page, "before").unwrap().to_owned();
    let older = store.page("marketing", Some(&before), None).unwrap();
    assert_eq!(
        kinds(&older),
        vec![("message".to_owned(), Some("message 0".to_owned()))]
    );
    assert_eq!(older.get("before"), Some(&Value::Null));
}

#[test]
fn the_conversation_skips_attached_and_web_turns_and_keeps_the_newest_eight() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let attached = turn();
    let file = json::object(vec![
        ("id", json::text("f".repeat(32))),
        ("name", json::text("notes.txt")),
        ("media_type", json::text("text/plain")),
        ("size", json::int(3)),
    ]);
    store
        .append_user("marketing", &attached, &json::text("Read this"), &[file])
        .unwrap();
    store
        .append_reply("marketing", &attached, &done("Read."), None)
        .unwrap();
    for index in 0..10 {
        let id = turn();
        store
            .append_user("marketing", &id, &json::text(format!("ask {index}")), &[])
            .unwrap();
        store
            .append_reply("marketing", &id, &done(&format!("answer {index}")), None)
            .unwrap();
    }
    let current = turn();
    store
        .append_user("marketing", &current, &json::text("now"), &[])
        .unwrap();
    let window = store.conversation("marketing", &current).unwrap();
    assert_eq!(window.len(), 8);
    assert_eq!(window[0].text, "ask 6");
    assert_eq!(window[7].text, "answer 9");
    assert!(
        window
            .iter()
            .all(|entry| entry.text != "Read this" && entry.text != "Read.")
    );
    assert_eq!(
        store.conversation("marketing", &turn()),
        Err(HistoryError::Unavailable)
    );
}

#[test]
fn one_resumable_turn_is_bound_and_a_finished_one_never_releases_its_successor() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let (first, second) = (turn(), turn());
    assert_eq!(store.resumable_turn("marketing"), Ok(None));
    for id in [&first, &second] {
        store
            .append_user("marketing", id, &json::text("Request"), &[])
            .unwrap();
    }
    assert!(store.bind_resumable_turn("marketing", &first).unwrap());
    assert!(!store.bind_resumable_turn("marketing", &second).unwrap());
    store.finish_resumable_turn(&second).unwrap();
    assert_eq!(
        store.resumable_turn("marketing").unwrap().as_deref(),
        Some(first.as_str())
    );
    store
        .append_reply("marketing", &first, &done("Done."), None)
        .unwrap();
    assert_eq!(store.resumable_turn("marketing"), Ok(None));
}

#[test]
fn a_reply_keeps_its_receipt_and_refuses_one_out_of_order() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let id = turn();
    store
        .append_user("marketing", &id, &json::text("Request"), &[])
        .unwrap();
    let step = |segment: i64, seq: i64| {
        json::object(vec![
            ("segment", json::int(segment)),
            ("seq", json::int(seq)),
            ("origin", json::text("team")),
            ("phase", json::text("model")),
            ("state", json::text("started")),
        ])
    };
    let disordered = Value::Array(vec![step(0, 2), step(0, 1)]);
    assert!(
        store
            .append_reply("marketing", &id, &done("Done."), Some(&disordered))
            .is_err()
    );
    let receipt = Value::Array(vec![step(0, 1), step(0, 2), step(1, 1)]);
    assert!(
        store
            .append_reply("marketing", &id, &done("Done."), Some(&receipt))
            .unwrap()
    );
    let page = store.page("marketing", None, None).unwrap();
    let reply = &json::as_array(page.get("entries").unwrap()).unwrap()[1];
    assert_eq!(
        json::as_array(reply.get("receipt").unwrap()).unwrap().len(),
        3
    );
}

#[test]
fn a_row_admin_did_not_write_fails_the_page_closed() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let id = turn();
    store
        .append_user("marketing", &id, &json::text("Request"), &[])
        .unwrap();
    let path = root.path().join("chat-history.sqlite3");
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE transcript SET payload = '{\"kind\":\"message\",\"role\":\"user\",\"text\":\"x\",\"secret\":1}'", [])
        .unwrap();
    assert_eq!(
        store.page("marketing", None, None),
        Err(HistoryError::Unavailable)
    );
}
