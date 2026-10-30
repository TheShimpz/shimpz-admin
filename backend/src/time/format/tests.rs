use super::*;

#[test]
fn an_instant_round_trips_through_its_utc_form() {
    for seconds in [0, 951_782_400, 1_760_000_000, 253_402_300_799] {
        assert_eq!(parse_utc(&utc(seconds)), Some(seconds));
    }
    assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(parse_utc("2001-02-29T00:00:00Z"), None);
    assert_eq!(parse_utc("2001-02-28 00:00:00Z"), None);
}
