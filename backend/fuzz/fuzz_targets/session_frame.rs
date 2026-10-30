//! Fuzzes the session socket's frame admission over arbitrary bytes: each frame is admitted or refused, never a panic.
#![no_main]

use admin_backend::{json, session::frames};

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let Ok(frame) = json::parse(data) else {
        return;
    };
    if let Ok(call) = frames::call(&frame) {
        let _ = frames::read_topic(call.method, &call.params);
        let _ = frames::body_limit(call.method);
    }
    let _ = frames::chat_frame(&frame);
    let _ = frames::activity(&frame);
    let _ = frames::topics(&frame);
    let _ = frames::chat_event("marketing", &frame);
    let _ = frames::encode(&frame);
});
