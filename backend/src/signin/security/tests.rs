use super::*;

#[test]
fn an_acknowledgment_names_one_positive_count_alone() {
    let count = |value: Value| acknowledged_count(&json::object(vec![("acknowledged", value)]));
    assert_eq!(count(json::int(3)), Some(3));
    assert_eq!(count(json::int(0)), None);
    assert_eq!(count(json::int(MAX_SECOND_FACTOR_FAILURES + 1)), None);
    assert_eq!(count(Value::Bool(true)), None);
    assert_eq!(count(json::text("3")), None);
    let extra = json::object(vec![("acknowledged", json::int(1)), ("x", json::int(1))]);
    assert_eq!(acknowledged_count(&extra), None);
}
