//! Fuzzes the platform release status the CLI projects: any file is the closed status or unavailable, never a panic.
#![no_main]

use admin_backend::space::release;

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let Ok(root) = tempfile::tempdir() else {
        return;
    };
    let path = root.path().join("status.json");
    if admin_backend::fsio::replace_atomically(&path, data).is_ok() {
        let _ = release::status_response(&path);
    }
});
