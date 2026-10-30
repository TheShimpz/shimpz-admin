use super::*;

#[test]
fn a_session_s_minute_is_its_own_and_slides() {
    let clock = Arc::new(Clock::new());
    let budget = Budget::new(2, Arc::clone(&clock));
    assert!(budget.admit("a") && budget.admit("a"));
    assert!(!budget.admit("a"));
    assert!(budget.admit("b"));
    clock.advance_ms(WINDOW_MS);
    assert!(budget.admit("a"));
}

#[test]
fn a_renewal_is_due_once_per_interval() {
    let clock = Arc::new(Clock::new());
    let renewals = Renewals::new(Arc::clone(&clock));
    assert!(renewals.due("a"));
    assert!(!renewals.due("a"));
    clock.advance_ms(RENEWAL_MS);
    assert!(renewals.due("a"));
}
