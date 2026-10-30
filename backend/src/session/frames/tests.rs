use super::*;

fn vectors() -> Value {
    json::parse(include_bytes!("../../../protocol/socket/v1/vectors.json")).unwrap()
}

fn group<'a>(vectors: &'a Value, path: &[&str]) -> &'a [Value] {
    let mut value = vectors;
    for key in path {
        value = json::get(value, key).unwrap();
    }
    json::as_array(value).unwrap()
}

#[test]
fn the_vectors_name_this_protocol() {
    let vectors = vectors();
    assert_eq!(json::get(&vectors, "version"), Some(&json::int(1)));
    assert_eq!(json::get_str(&vectors, "subprotocol"), Some(SUBPROTOCOL));
    assert_eq!(json::get_str(&vectors, "path"), Some(PATH));
}

#[test]
fn every_valid_call_is_admitted_and_every_invalid_one_refused() {
    let vectors = vectors();
    for frame in group(&vectors, &["calls", "valid"]) {
        let admitted = call(frame).unwrap();
        assert_eq!(Some(admitted.id.as_str()), json::get_str(frame, "id"));
        assert_eq!(Some(admitted.method), json::get_str(frame, "method"));
        assert_eq!(Some(&admitted.params), json::get(frame, "params"));
    }
    for frame in group(&vectors, &["calls", "invalid"]) {
        assert!(call(frame).is_err(), "{}", json::compact(frame));
    }
}

#[test]
fn activity_frames_are_exact() {
    let vectors = vectors();
    for frame in group(&vectors, &["activity", "valid"]) {
        activity(frame).unwrap();
    }
    for frame in group(&vectors, &["activity", "invalid"]) {
        assert!(activity(frame).is_err());
    }
}

#[test]
fn chat_frames_and_events_are_exact() {
    let vectors = vectors();
    for case in group(&vectors, &["chat", "valid"]) {
        let (team, v7) = chat_frame(json::get(case, "frame").unwrap()).unwrap();
        assert_eq!(Some(team.as_str()), json::get_str(case, "team_id"));
        assert_eq!(Some(&v7), json::get(case, "v7"));
    }
    for frame in group(&vectors, &["chat", "invalid"]) {
        assert!(chat_frame(frame).is_err());
    }
    for event in group(&vectors, &["server", "chat"]) {
        let without = json::without(event, "team_id");
        assert!(json::equal(
            &chat_event("marketing", &without).unwrap(),
            event
        ));
    }
    let other = json::object(vec![
        ("type", json::text("done")),
        ("team_id", json::text("sales")),
    ]);
    assert!(chat_event("marketing", &other).is_none());
}

#[test]
fn server_frames_are_the_exact_vector_shapes() {
    let vectors = vectors();
    let server = json::get(&vectors, "server").unwrap();
    let result_vector = json::get(server, "result").unwrap();
    let revision = Revision {
        topic: json::get_str(result_vector, "topic").unwrap().to_owned(),
        epoch: json::get_str(result_vector, "epoch").unwrap().to_owned(),
        revision: 3,
    };
    let built = result(
        json::get_str(result_vector, "id").unwrap(),
        200,
        json::get(result_vector, "body").unwrap().clone(),
        Some(&revision),
    );
    assert!(json::equal(&built, result_vector));
    let session_vector = json::get(server, "session").unwrap();
    let source = SourceBuild::admitted(
        json::get_str(session_vector, "source_revision").unwrap(),
        json::as_int(json::get(session_vector, "source_time").unwrap()).unwrap(),
    );
    assert!(json::equal(
        &session(3480, 82800, source.as_ref()),
        session_vector
    ));
    assert!(json::equal(
        &session(3480, 82800, None),
        json::get(server, "session_unnamed").unwrap()
    ));
    let progress_vector = json::get(server, "progress").unwrap();
    assert!(json::equal(
        &progress(json::get_str(progress_vector, "id").unwrap()),
        progress_vector
    ));
    for (revision, time) in [
        ("A".repeat(40), 1),
        ("a".repeat(39), 1),
        ("a".repeat(40), 0),
        ("a".repeat(40), MAX_SOURCE_TIME + 1),
    ] {
        assert!(SourceBuild::admitted(&revision, time).is_none());
    }
}

#[test]
fn topics_follow_the_closed_grammar_and_bounds_hold() {
    let vectors = vectors();
    for topic in group(&vectors, &["topics", "valid"]) {
        assert!(is_topic(json::as_str(topic).unwrap()));
    }
    for topic in group(&vectors, &["topics", "invalid"]) {
        assert!(json::as_str(topic).is_none_or(|topic| !is_topic(topic)));
    }
    let bodies: Vec<&str> = METHODS
        .iter()
        .filter(|(_, required, _)| required.contains(&"body"))
        .map(|(name, _, _)| *name)
        .collect();
    let mut bounded: Vec<&str> = BODY_BYTES.iter().map(|(name, _)| *name).collect();
    bounded.sort_unstable();
    let mut expected = bodies.clone();
    expected.sort_unstable();
    assert_eq!(bounded, expected);
    assert!(
        encode(&result(
            "c",
            200,
            json::object(vec![("text", json::text("x".repeat(MAX_OUTBOUND_BYTES)))]),
            None
        ))
        .is_err()
    );
}
