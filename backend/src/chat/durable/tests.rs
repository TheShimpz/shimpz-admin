use std::collections::HashSet;

use super::{Grant, MAX_TURNS, Pending, Turns};
use crate::json;

fn pending(team: &str, nonce: &str, session: &str) -> Pending {
    Pending {
        team_id: team.to_owned(),
        history_id: Some("h".repeat(32)),
        nonce: nonce.to_owned(),
        body: json::object(vec![("message", json::text("Hello"))]),
        grant: Grant {
            session: session.to_owned(),
            origin: "http://127.0.0.1:7777".to_owned(),
            secret: "c".repeat(64),
            expires_at: 2_000_000_000,
            idle_until: 1_900_000_000,
        },
        revoked: false,
    }
}

#[test]
fn a_turn_is_kept_across_processes_until_it_is_removed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("turns.json");
    let turns = Turns::new(&path);
    turns
        .record(pending("marketing", "1", &"a".repeat(64)))
        .unwrap();
    // Its run owns it: the sweep leaves it alone, until the run hands it back.
    assert_eq!(turns.unowned().unwrap().len(), 0);
    turns.release("marketing", "1");
    assert_eq!(
        turns.unowned().unwrap(),
        [pending("marketing", "1", &"a".repeat(64))]
    );
    // A later process finds it and owns none of it.
    let later = Turns::new(&path);
    assert_eq!(later.unowned().unwrap().len(), 1);
    later.remove("marketing", "1").unwrap();
    assert_eq!(later.unowned().unwrap().len(), 0);
}

#[test]
fn an_ended_session_revokes_its_turns_and_only_its_own() {
    let directory = tempfile::tempdir().unwrap();
    let turns = Turns::new(&directory.path().join("turns.json"));
    turns
        .record(pending("marketing", "1", &"a".repeat(64)))
        .unwrap();
    turns
        .record(pending("marketing", "2", &"b".repeat(64)))
        .unwrap();
    let ended: HashSet<String> = std::iter::once("a".repeat(64)).collect();
    turns.revoke(Some(&ended)).unwrap();
    assert!(turns.revoked("marketing", "1"));
    assert!(!turns.revoked("marketing", "2"));
    turns.revoke(None).unwrap();
    assert!(turns.revoked("marketing", "2"));
}

#[test]
fn a_team_s_turns_go_with_it_and_admin_keeps_a_bounded_number() {
    let directory = tempfile::tempdir().unwrap();
    let turns = Turns::new(&directory.path().join("turns.json"));
    for index in 0..MAX_TURNS {
        turns
            .record(pending("marketing", &index.to_string(), &"a".repeat(64)))
            .unwrap();
    }
    assert!(
        turns
            .record(pending("sales", "x", &"a".repeat(64)))
            .is_err()
    );
    turns.forget(Some("marketing")).unwrap();
    turns
        .record(pending("sales", "x", &"a".repeat(64)))
        .unwrap();
    turns.forget(None).unwrap();
    turns.release("sales", "x");
    assert_eq!(turns.unowned().unwrap().len(), 0);
}
