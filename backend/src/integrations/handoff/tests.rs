use super::*;

const SESSION: &str = "v3:1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:totp:bbbbbbbb";
const CHALLENGE: &str = "0123456789abcdef0123456789abcdef";

fn url(state: &str, mode: &str) -> String {
    format!(
        "https://shimpz.com/api/oauth/cloudflare/start?state={state}&code_challenge={state}&scope=zone.read&callback={mode}"
    )
}

#[test]
fn an_automatic_handoff_is_consumed_once_by_its_own_mode() {
    let handoffs = Handoffs::new(Arc::new(Clock::new()));
    let preparation = handoffs
        .issue("marketing", CHALLENGE, SESSION, "loopback")
        .unwrap();
    assert!(
        handoffs
            .issue("marketing", CHALLENGE, SESSION, "loopback")
            .is_err()
    );
    assert!(
        handoffs.consume(&preparation.token, "loopback").is_err(),
        "not yet authorized"
    );
    let preparation = handoffs
        .issue("marketing", CHALLENGE, SESSION, "loopback")
        .unwrap();
    let state = "s".repeat(43);
    handoffs
        .authorize(&preparation.token, &url(&state, "loopback"))
        .unwrap();
    assert!(
        handoffs
            .consume(&preparation.token, "local-domain")
            .is_err()
    );
    let preparation = handoffs
        .issue("marketing", CHALLENGE, SESSION, "loopback")
        .unwrap();
    handoffs
        .authorize(&preparation.token, &url(&state, "loopback"))
        .unwrap();
    let handoff = handoffs.consume(&preparation.token, "loopback").unwrap();
    assert_eq!(handoff.session_binding, preparation.session_binding);
    assert!(handoffs.consume(&preparation.token, "loopback").is_err());
}

#[test]
fn an_out_of_band_completion_needs_its_session_and_state() {
    let clock = Arc::new(Clock::new());
    let handoffs = Handoffs::new(Arc::clone(&clock));
    let preparation = handoffs
        .issue("marketing", CHALLENGE, SESSION, "out-of-band")
        .unwrap();
    let state = "t".repeat(43);
    handoffs
        .authorize(&preparation.token, &url(&state, "out-of-band"))
        .unwrap();
    let code = format!("c1.{state}.{}", "f".repeat(64));
    let other = "v3:1:cccccccccccccccccccccccccccccccccccc:totp:dddddddd";
    assert!(
        handoffs
            .complete("marketing", CHALLENGE, other, &code)
            .is_err()
    );
    assert!(
        handoffs
            .complete(
                "marketing",
                CHALLENGE,
                SESSION,
                &format!("c1.{}.{}", "u".repeat(43), "f".repeat(64))
            )
            .is_err()
    );
    let completion = handoffs
        .complete("marketing", CHALLENGE, SESSION, &code)
        .unwrap();
    assert_eq!(completion.session_binding, preparation.session_binding);
    let again = handoffs
        .issue("marketing", CHALLENGE, SESSION, "out-of-band")
        .unwrap();
    clock.advance_ms(HANDOFF_TTL_MS);
    assert_eq!(
        handoffs.cancel("marketing", CHALLENGE, SESSION).unwrap(),
        None
    );
    assert!(!handoffs.discard(&again.token));
}
