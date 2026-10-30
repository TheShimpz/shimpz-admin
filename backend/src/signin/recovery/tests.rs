use super::*;

#[test]
fn a_code_is_typed_in_any_case_with_spaces_and_hyphens() {
    assert_eq!(
        normalized(&json::text("ABCD-0123 wxyz")),
        Some("abcd0123wxyz".to_owned())
    );
    assert_eq!(normalized(&json::text("abcd-0123-wxyi")), None);
    assert_eq!(normalized(&json::text("a".repeat(65))), None);
    let salt: Vec<u8> = (0..32).collect();
    assert_eq!(
        digest("abcd0123wxyz", &salt),
        "5c7ca3a4c029df9c293513a5abffc62b919de701f9630af0b62d8e4093134e29"
    );
}

#[test]
fn each_code_of_a_set_is_spent_once() {
    let set = new_set();
    assert_eq!(set.codes.len(), CODE_COUNT);
    assert!(
        set.codes
            .iter()
            .all(|code| code.len() == 14 && code.matches('-').count() == 2)
    );
    let mut record = set.record.clone();
    assert_eq!(remaining(&record), Ok(10));
    let derived = candidate(&record, &json::text(&set.codes[3])).unwrap();
    assert_eq!(spend(&mut record, &derived, 1_760_000_000), Ok(true));
    assert_eq!(spend(&mut record, &derived, 1_760_000_001), Ok(false));
    assert_eq!(remaining(&record), Ok(9));
    let wrong = candidate(&record, &json::text("zzzz-zzzz-zzzz")).unwrap();
    assert_eq!(spend(&mut record, &wrong, 1_760_000_002), Ok(false));
}
