use super::*;

#[test]
fn text_is_nfc_trimmed_and_free_of_controls_but_layout_and_format() {
    assert_eq!(canonical_text("e\u{301}").unwrap(), "\u{e9}");
    assert_eq!(canonical_text("a\nb\tc").unwrap(), "a\nb\tc");
    assert_eq!(canonical_text("a\u{200b}b").unwrap(), "a\u{200b}b");
    for refused in ["", " a", "a\u{0}", "a\u{7}b"] {
        assert!(canonical_text(refused).is_err(), "{refused:?}");
    }
}

#[test]
fn a_routable_objective_replaces_what_team_refuses() {
    assert_eq!(routable_text(" a\u{0}b "), "a\u{fffd}b");
    assert_eq!(routable_text("plain"), "plain");
    assert_eq!(
        text::len(&routable_text(&"x".repeat(MAX_OBJECTIVE_CHARS + 5))),
        MAX_OBJECTIVE_CHARS
    );
}

#[test]
fn a_long_entry_keeps_its_head_and_tail() {
    let long = format!("{}{}", "a".repeat(300), "b".repeat(300));
    let entry = bounded("user", &long).unwrap();
    assert!(entry.truncated);
    assert_eq!(text::len(&entry.text), MAX_TEXT_CHARS);
    assert!(entry.text.starts_with('a') && entry.text.ends_with('b') && entry.text.contains('…'));
    assert!(bounded("system", "x").is_err());
}

#[test]
fn a_window_beyond_its_bounds_is_refused() {
    let entry = bounded("user", &"x".repeat(MAX_TEXT_CHARS)).unwrap();
    assert!(admit(&vec![entry.clone(); MAX_ENTRIES]).is_ok());
    assert!(admit(&vec![entry; MAX_ENTRIES + 1]).is_err());
}
