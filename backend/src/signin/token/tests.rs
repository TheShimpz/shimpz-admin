use std::sync::Arc;

use super::*;

const SECRET: &str = "0101010101010101010101010101010101010101010101010101010101010101";

fn sessions() -> (Arc<Clock>, Sessions) {
    let clock = Arc::new(Clock::new());
    let sessions = Sessions::new(Arc::clone(&clock));
    (clock, sessions)
}

#[test]
fn a_session_is_v3_signed_by_the_store_secret() {
    let (clock, sessions) = sessions();
    let token = issue(&sessions, SECRET, Method::Totp, clock.now_secs());
    let parts: Vec<&str> = token.split(':').collect();
    assert_eq!((parts.len(), parts[0], parts[3]), (5, "v3", "pwd+totp"));
    assert_eq!(
        verify(&sessions, &clock, SECRET, &token, false).map(|evidence| evidence.method),
        Some(Method::Totp)
    );
    let other = "02".repeat(32);
    assert!(verify(&sessions, &clock, &other, &token, false).is_none());
    let forged = token.replace("pwd+totp", "pwd+webauthn");
    assert!(verify(&sessions, &clock, SECRET, &forged, false).is_none());
}

#[test]
fn only_activity_renews_and_nothing_revives_an_expired_session() {
    let (clock, sessions) = sessions();
    let token = issue(&sessions, SECRET, Method::Totp, clock.now_secs());
    clock.advance(3000);
    assert!(verify(&sessions, &clock, SECRET, &token, false).is_some());
    clock.advance(700);
    assert!(
        verify(&sessions, &clock, SECRET, &token, true).is_none(),
        "an idle hour ends it"
    );

    let token = issue(&sessions, SECRET, Method::Totp, clock.now_secs());
    for _ in 0..28 {
        clock.advance(3000);
        assert!(verify(&sessions, &clock, SECRET, &token, true).is_some());
    }
    clock.advance(3000);
    assert!(
        verify(&sessions, &clock, SECRET, &token, true).is_none(),
        "a day ends it whatever its activity"
    );
}

#[test]
fn a_session_this_process_never_issued_is_refused() {
    let (clock, sessions) = sessions();
    let token = issue(&sessions, SECRET, Method::Webauthn, clock.now_secs());
    let (_, restarted) = self::sessions();
    assert!(verify(&restarted, &clock, SECRET, &token, false).is_none());
    sessions.end_all();
    assert!(verify(&sessions, &clock, SECRET, &token, false).is_none());
}

#[test]
fn deadlines_count_down_from_the_last_activity_and_the_sign_in() {
    let (clock, sessions) = sessions();
    let token = issue(&sessions, SECRET, Method::Totp, clock.now_secs());
    clock.advance(600);
    let (idle, absolute) = deadlines(&sessions, &clock, SECRET, &token).unwrap();
    assert!((2_999_000..=3_000_000).contains(&idle));
    assert!((85_799_000..=85_800_000).contains(&absolute));
}
