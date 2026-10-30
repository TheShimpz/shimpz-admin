use super::*;

#[test]
fn a_name_s_ids_are_its_own_then_nine_suffixes_of_a_bounded_stem() {
    let ids = candidate_ids("Marketing Team").unwrap();
    assert_eq!(ids.len(), MAX_ID_SUFFIX);
    assert_eq!(ids[0], "marketing_team");
    assert_eq!(ids[1], "marketing_team_2");
    assert_eq!(ids[8], "marketing_team_9");
    let long = candidate_ids(&format!("{}_b", "a".repeat(37))).unwrap();
    assert_eq!(long[1], format!("{}_2", "a".repeat(37)));
    assert_eq!(
        candidate_ids("!!!").unwrap_err().reply().body,
        json::detail("team name has no usable characters")
    );
}

#[test]
fn a_deletion_names_the_team_and_a_bounded_password() {
    let body = |name: Value, password: Value| {
        json::object(vec![("team_name", name), ("password", password)])
    };
    let (name, password) = deletion(&body(json::text("Sales"), json::text("pw"))).unwrap();
    assert_eq!((name.as_str(), password), ("Sales", json::text("pw")));
    let refused = |payload: &Value| deletion(payload).unwrap_err().reply();
    assert_eq!(
        refused(&body(json::int(1), json::text("pw"))).body,
        json::detail("Team name and password must be strings")
    );
    assert_eq!(
        refused(&body(json::text("Sales"), json::text(""))).body,
        json::detail("Supervisor password is invalid")
    );
    assert_eq!(
        refused(&json::object(vec![("team_name", json::text("Sales"))])).status,
        400
    );
}

#[test]
fn a_team_name_is_trimmed_and_normalized_before_team_admits_it() {
    let named = |value: &str| team_name(&json::object(vec![("team_name", json::text(value))]));
    assert_eq!(named("  Cafe\u{301}  ").unwrap(), "Caf\u{e9}");
    assert_eq!(named("").unwrap_err().reply().status, 400);
    assert_eq!(
        team_name(&json::object(vec![("team_name", json::int(1))]))
            .unwrap_err()
            .reply()
            .body,
        json::detail("team name must be a string")
    );
}
