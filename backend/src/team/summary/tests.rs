use super::*;

fn registry(assistants: Value) -> Reply {
    Reply::ok(json::object(vec![
        ("assistants", assistants),
        ("trace_id", json::text("0".repeat(32))),
    ]))
}

fn named(id: &str, title: &str) -> Value {
    json::object(vec![("id", json::text(id)), ("title", json::text(title))])
}

#[test]
fn the_registry_names_each_canonical_identity_once_with_a_safe_title() {
    let answer = names(&registry(Value::Array(vec![
        named("weather", "Weather"),
        named("notes", "Notes"),
    ])))
    .unwrap();
    assert_eq!(
        answer,
        vec![
            ("weather".to_owned(), "Weather".to_owned()),
            ("notes".to_owned(), "Notes".to_owned())
        ]
    );
    for refused in [
        Value::Array(vec![named("weather", "A"), named("weather", "B")]),
        Value::Array(vec![named("Weather", "A")]),
        Value::Array(vec![named("weather", " padded")]),
        Value::Array(vec![named("weather", "line\u{7}")]),
        Value::Array(vec![json::object(vec![("id", json::text("weather"))])]),
    ] {
        assert_eq!(
            names(&registry(refused.clone())),
            None,
            "{}",
            json::compact(&refused)
        );
    }
    let untraced = Reply::ok(json::object(vec![
        ("assistants", Value::Array(Vec::new())),
        ("x", json::int(1)),
    ]));
    assert_eq!(names(&untraced), None);
}

#[test]
fn a_summary_in_another_locale_or_shape_is_invalid_and_a_failure_passes() {
    let busy = Reply::new(503, json::code("preview-busy"));
    assert_eq!(
        localized(busy.clone(), "en", "Assistant", Kind::Summary).unwrap(),
        busy
    );
    let other = Reply::ok(json::object(vec![("locale", json::text("pt"))]));
    assert_eq!(
        localized(other, "en", "Local Assistant", Kind::Summary)
            .unwrap_err()
            .reply()
            .body,
        json::detail("Local Assistant summary is invalid")
    );
    assert_eq!(
        canonical_locale("xx", Kind::Details)
            .unwrap_err()
            .reply()
            .status,
        422
    );
}
