//! Fuzzes the classification of an `admin.json` record and its factor records: each is admitted or refused, never a
//! panic.
#![no_main]

use admin_backend::{
    json,
    record::classify,
    signin::{password, recovery, totp},
};

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let Ok(record) = json::parse(data) else {
        return;
    };
    let _ = classify::authentication_state(&record);
    let _ = classify::validated_passkeys(&record);
    let _ = classify::consumed_host_resets(&record);
    let _ = password::password_material(&record);
    let _ = totp::validated(&record);
    let _ = totp::state(&record);
    let _ = recovery::validated(&record);
    let _ = recovery::remaining(&record);
    let _ = recovery::normalized(&record);
});
