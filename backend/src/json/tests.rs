use super::*;

#[test]
fn the_store_layout_is_python_s_indented_sorted_ascii_json() {
    let value = object(vec![
        (
            "b",
            Value::Array(vec![
                int(1),
                object(vec![("x", text("é")), ("a", Value::Array(Vec::new()))]),
            ]),
        ),
        ("a", empty()),
        ("c", Value::Null),
    ]);
    let expected = "{\n  \"a\": {},\n  \"b\": [\n    1,\n    {\n      \"a\": [],\n      \"x\": \"\\u00e9\"\n    }\n  ],\n  \"c\": null\n}";
    assert_eq!(indented(&value), expected);
}

#[test]
fn a_member_set_keeps_its_place_and_a_new_one_follows() {
    let mut value = object(vec![("a", int(1)), ("b", int(2))]);
    set(&mut value, "a", int(3));
    set(&mut value, "c", int(4));
    assert_eq!(compact(&value), "{\"a\":3,\"b\":2,\"c\":4}");
    assert!(equal(
        &value,
        &object(vec![("c", int(4)), ("b", int(2)), ("a", int(3))])
    ));
}
