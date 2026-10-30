use super::*;

fn item(assistant: &str, stored: &str, status: &str) -> Value {
    json::object(vec![
        ("assistant_id", json::text(assistant)),
        ("stored_input_id", json::text(stored)),
        ("status", json::text(status)),
    ])
}

fn body(items: Vec<Value>) -> Value {
    json::object(vec![
        ("team_id", json::text("sales")),
        ("stored_inputs", Value::Array(items)),
        ("trace_id", json::text("a".repeat(32))),
    ])
}

#[test]
fn only_a_sorted_unique_metadata_inventory_of_this_team_is_shown() {
    let listed = inventory(
        &body(vec![
            item("a", "key", "stored"),
            item("b", "key", "missing"),
        ]),
        "sales",
    )
    .unwrap();
    assert_eq!(json::as_array(&listed).unwrap().len(), 2);
    for refused in [
        vec![item("b", "key", "stored"), item("a", "key", "stored")],
        vec![item("a", "key", "stored"), item("a", "key", "missing")],
        vec![item("a", "key", "secret")],
        vec![json::object(vec![
            ("assistant_id", json::text("a")),
            ("value", json::text("x")),
        ])],
    ] {
        assert_eq!(inventory(&body(refused), "sales"), None);
    }
    assert_eq!(inventory(&body(Vec::new()), "marketing"), None);
    assert_eq!(
        inventory(&json::without(&body(Vec::new()), "trace_id"), "sales"),
        None
    );
}
