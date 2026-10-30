use super::*;

#[test]
fn a_failure_carries_only_a_safe_code_and_a_success_only_its_closed_view() {
    let failed = projected(
        &Reply::new(
            404,
            json::object(vec![
                ("code", json::text("routine-not-found")),
                ("secret", json::text("x")),
            ]),
        ),
        |_| None,
    );
    assert_eq!(failed, Reply::new(404, json::code("routine-not-found")));
    let unsafe_code = projected(&Reply::new(409, json::code("Not Safe")), |_| None);
    assert_eq!(
        unsafe_code,
        Reply::new(409, json::code("routine-request-failed"))
    );
    assert_eq!(
        projected(&Reply::new(302, json::empty()), |_| None).status,
        502
    );
    let untraced = projected(
        &Reply::ok(json::object(vec![("a", json::int(1))])),
        |body| Some(body.clone()),
    );
    assert_eq!(untraced, invalid());
    let traced = json::object(vec![
        ("a", json::int(1)),
        ("trace_id", json::text("e".repeat(32))),
    ]);
    assert_eq!(
        projected(&Reply::ok(traced.clone()), |body| Some(body.clone())),
        Reply::ok(json::object(vec![("a", json::int(1))]))
    );
    assert_eq!(projected(&Reply::ok(traced), |_| None), invalid());
}

#[test]
fn path_counts_and_ids_have_one_canonical_form() {
    assert_eq!(offset("0").unwrap(), 0);
    for refused in ["00", "-1", "1.0", "256", ""] {
        assert!(offset(refused).is_err(), "{refused}");
    }
    assert!(canonical_id(&"a".repeat(32), "Routine").is_ok());
    assert_eq!(
        canonical_id("A", "Routine run").unwrap_err(),
        Fault::team_request("Routine run is invalid")
    );
    assert_eq!(
        deletion_subject("sales", &"f".repeat(32)).unwrap(),
        format!("routine-delete:sales:{}", "f".repeat(32))
    );
}

#[test]
fn a_bound_view_must_name_exactly_what_was_asked_for() {
    let view = json::object(vec![
        ("team_id", json::text("sales")),
        ("run_id", json::text("r")),
    ]);
    assert!(bound(Some(&view), &[("team_id", json::text("sales"))]).is_some());
    assert!(bound(Some(&view), &[("team_id", json::text("marketing"))]).is_none());
    assert!(bound(None, &[]).is_none());
}
