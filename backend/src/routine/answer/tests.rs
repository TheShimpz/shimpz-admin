use super::*;

fn key(team: &str, challenge: &str) -> Key {
    (team.to_owned(), "r".to_owned(), challenge.to_owned())
}

#[test]
fn a_team_keeps_one_open_challenge_taken_once_until_it_expires() {
    let clock = Arc::new(Clock::new());
    let challenges = Challenges::new(Arc::clone(&clock));
    let deadline = clock.monotonic_ms() + 1_000;
    challenges.remember(key("sales", "a"), deadline, json::text("first"));
    challenges.remember(key("sales", "b"), deadline, json::text("second"));
    assert!(challenges.take(&key("sales", "a")).is_none());
    let (_, request, generation) = challenges.take(&key("sales", "b")).unwrap();
    assert_eq!(request, json::text("second"));
    assert!(challenges.take(&key("sales", "b")).is_none());
    challenges.restore(key("sales", "b"), deadline, request, generation);
    clock.advance_ms(1_000);
    assert!(challenges.take(&key("sales", "b")).is_none());
}

#[test]
fn a_rejected_answer_is_not_restored_over_a_newer_opening() {
    let clock = Arc::new(Clock::new());
    let challenges = Challenges::new(Arc::clone(&clock));
    let deadline = clock.monotonic_ms() + 60_000;
    challenges.remember(key("sales", "a"), deadline, json::text("old"));
    let (_, request, generation) = challenges.take(&key("sales", "a")).unwrap();
    challenges.remember(key("sales", "b"), deadline, json::text("new"));
    challenges.restore(key("sales", "a"), deadline, request, generation);
    assert!(challenges.take(&key("sales", "a")).is_none());
    assert!(challenges.take(&key("sales", "b")).is_some());
}

#[test]
fn the_open_challenges_are_bounded() {
    let clock = Arc::new(Clock::new());
    let challenges = Challenges::new(Arc::clone(&clock));
    let deadline = clock.monotonic_ms() + 60_000;
    for index in 0..=MAX_OPEN_CHALLENGES {
        challenges.remember(key(&format!("t{index}"), "c"), deadline, Value::Null);
    }
    assert!(challenges.take(&key("t0", "c")).is_none());
    assert!(
        challenges
            .take(&key(&format!("t{MAX_OPEN_CHALLENGES}"), "c"))
            .is_some()
    );
}

#[test]
fn a_challenge_frame_names_only_its_fields_in_protocol_order() {
    let projected = json::object(vec![
        ("purpose", json::text("p")),
        ("challenge_id", json::text("c")),
        ("secret", json::text("never")),
    ]);
    let frame = challenge(&projected);
    let names: Vec<&str> = json::members(&frame)
        .unwrap()
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(names, ["type", "challenge_id", "purpose"]);
}
