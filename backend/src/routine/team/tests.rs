use super::*;

fn delivery(index: usize, padding: usize) -> Value {
    json::object(vec![
        ("team_id", json::text("sales")),
        ("notice_id", json::text(format!("{index:032x}"))),
        ("version", json::int(i64::try_from(padding).unwrap())),
    ])
}

#[test]
fn acknowledgments_fit_team_s_count_and_admin_s_body_bound() {
    let total = routine_run::MAX_ACK_DELIVERIES + 3;
    let many: Vec<Value> = (0..total).map(|index| delivery(index, 1)).collect();
    let chunks = acknowledgments(many);
    assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), total);
    assert!(
        chunks
            .iter()
            .all(|chunk| chunk.len() <= routine_run::MAX_ACK_DELIVERIES)
    );
    let small: Vec<Value> = (0..=routine_run::MAX_ACK_DELIVERIES)
        .map(|index| json::object(vec![("v", json::int(i64::try_from(index).unwrap()))]))
        .collect();
    assert_eq!(
        acknowledgments(small)
            .iter()
            .map(Vec::len)
            .collect::<Vec<_>>(),
        [routine_run::MAX_ACK_DELIVERIES, 1]
    );
    for chunk in &chunks {
        let body = json::object(vec![("deliveries", Value::Array(chunk.clone()))]);
        assert!(json::compact_len(&body) <= MAX_JSON_BODY_BYTES);
    }
    assert_eq!(acknowledgments(Vec::new()), Vec::<Vec<Value>>::new());
}

#[test]
fn only_a_traced_200_answer_is_admitted() {
    let traced = json::object(vec![
        ("acknowledged", Value::Bool(true)),
        ("trace_id", json::text("c".repeat(32))),
    ]);
    assert_eq!(
        answer(&Reply::ok(traced.clone())),
        Ok(json::object(vec![("acknowledged", Value::Bool(true))]))
    );
    assert_eq!(answer(&Reply::new(201, traced)), Err(RoutineTeamError));
    assert_eq!(
        answer(&Reply::ok(json::object(vec![(
            "trace_id",
            json::text("x")
        )]))),
        Err(RoutineTeamError)
    );
}

#[test]
fn a_segment_waits_for_its_claimed_active_time_and_a_margin() {
    let claimed = |seconds: i64| json::object(vec![("active_seconds", json::int(seconds))]);
    assert_eq!(run_timeout(&claimed(60)), Duration::from_mins(15));
    assert_eq!(run_timeout(&claimed(7200)), Duration::from_mins(125));
    assert!(!is_long(&claimed(routine_run::SHORT_ACTIVE_SECONDS)));
    assert!(is_long(&claimed(routine_run::SHORT_ACTIVE_SECONDS + 1)));
}
