use super::*;

fn reply(status: u16, body: Value) -> Reply {
    Reply::new(status, body)
}

#[test]
fn only_team_pinning_exactly_the_pending_key_switches_and_a_server_failure_decides_nothing() {
    let pending = LocalIdentity::generate();
    let digest = HEXLOWER.encode(&Sha256::digest(pending.public_key_raw()));
    let pinned = json::object(vec![
        ("rotated", Value::Bool(true)),
        ("key_sha256", json::text(&digest)),
        ("trace_id", json::text("a".repeat(32))),
    ]);
    assert_eq!(switched(&reply(200, pinned), &pending), Some(true));
    let other = json::object(vec![
        ("rotated", Value::Bool(true)),
        ("key_sha256", json::text("0".repeat(64))),
    ]);
    assert_eq!(switched(&reply(200, other), &pending), None);
    assert_eq!(
        switched(&reply(502, json::detail("team unavailable")), &pending),
        None
    );
    assert_eq!(
        switched(&reply(409, json::detail("refused")), &pending),
        Some(false)
    );
}

#[test]
fn a_rotation_that_cannot_begin_is_busy_and_any_other_failure_unavailable() {
    assert_eq!(
        RotationFailure::from(StateError::Rotation),
        RotationFailure::Busy
    );
    assert_eq!(
        RotationFailure::from(StateError::Audit),
        RotationFailure::Unavailable
    );
}
