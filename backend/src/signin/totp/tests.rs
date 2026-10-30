use super::*;
use crate::json;

const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

#[test]
fn codes_follow_rfc_6238_with_sha_1_and_six_digits() {
    assert_eq!(code_at(RFC_SECRET, 59), "287082");
    assert_eq!(code_at(RFC_SECRET, 1_111_111_109), "081804");
}

fn active(now: i64) -> Value {
    let mut record = new_record(now);
    json::set(&mut record, "secret", json::text(RFC_SECRET));
    let code = json::text(code_at(RFC_SECRET, now));
    assert_eq!(verify(&mut record, &code, now), Ok(Verification::Accepted));
    record
}

#[test]
fn a_code_is_accepted_once_within_one_step_either_side() {
    let now = 1_760_000_010;
    let mut record = active(now);
    assert_eq!(json::get_str(&record, "status"), Some("active"));
    let replay = json::text(code_at(RFC_SECRET, now));
    assert_eq!(verify(&mut record, &replay, now), Ok(Verification::Invalid));
    let next = json::text(code_at(RFC_SECRET, now + 30));
    assert_eq!(verify(&mut record, &next, now), Ok(Verification::Accepted));
    let far = json::text(code_at(RFC_SECRET, now + 120));
    assert_eq!(verify(&mut record, &far, now), Ok(Verification::Invalid));
}

#[test]
fn the_lock_starts_at_five_minutes_and_doubles_to_four_hours() {
    assert_eq!(
        (0..5).map(lock_seconds).collect::<Vec<_>>(),
        vec![0, 0, 0, 0, 0]
    );
    assert_eq!(lock_seconds(5), 300);
    assert_eq!(lock_seconds(6), 600);
    assert_eq!(lock_seconds(30), 4 * 3600);
}

#[test]
fn a_fifth_refusal_locks_even_the_right_code_until_the_lock_ends() {
    let now = 1_760_000_010;
    let mut record = active(now);
    let wrong = json::text("000000");
    for _ in 0..4 {
        assert_eq!(verify(&mut record, &wrong, now), Ok(Verification::Invalid));
    }
    assert_eq!(verify(&mut record, &wrong, now), Ok(Verification::Locked));
    let right = json::text(code_at(RFC_SECRET, now + 299));
    assert_eq!(
        verify(&mut record, &right, now + 299),
        Ok(Verification::Locked)
    );
    let later = json::text(code_at(RFC_SECRET, now + 300));
    assert_eq!(
        verify(&mut record, &later, now + 300),
        Ok(Verification::Accepted)
    );
    assert_eq!(record.get("failures"), Some(&json::int(0)));
}

#[test]
fn a_pending_enrollment_expires_and_only_exact_factors_are_valid() {
    let now = 1_760_000_010;
    let mut record = new_record(now);
    let secret = json::get_str(&record, "secret").unwrap().to_owned();
    let late = json::text(code_at(&secret, now + ENROLLMENT_TTL_SECONDS + 1));
    assert_eq!(
        verify(&mut record, &late, now + ENROLLMENT_TTL_SECONDS + 1),
        Ok(Verification::Expired)
    );
    let mut extra = record.clone();
    json::set(&mut extra, "extra", json::int(1));
    assert_eq!(validated(&extra), Err(TotpStateError));
    json::set(&mut record, "secret", json::text("A".repeat(31)));
    assert_eq!(validated(&record), Err(TotpStateError));
}
