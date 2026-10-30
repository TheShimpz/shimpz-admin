//! Fuzzes the inline script extraction the page policy hashes: any document yields scripts, never a panic.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let _ = admin_backend::http::statics::inline_scripts(&text);
});
