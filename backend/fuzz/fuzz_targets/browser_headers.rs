//! Fuzzes the browser policy over arbitrary request headers: Fetch Metadata, Origin, and the session cookie each decide,
//! never panic.
#![no_main]

use admin_backend::http::{browser, statics};
use http::{HeaderMap, HeaderName, HeaderValue, Method};

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    let mut headers = HeaderMap::new();
    for line in data.split(|byte| *byte == b'\n') {
        let Some(colon) = line.iter().position(|byte| *byte == b':') else {
            continue;
        };
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(&line[..colon]),
            HeaderValue::from_bytes(&line[colon + 1..]),
        ) {
            headers.append(name, value);
        }
    }
    let admitted = vec!["http://127.0.0.1:7777".to_owned()];
    let _ = browser::cookie(&headers, "shimpz_admin");
    let _ = browser::from_admin_page(&headers, &admitted);
    let _ = browser::admits_unsafe_request(&Method::POST, &headers, &admitted);
    let _ = browser::request_origin(&headers);
    let _ = browser::same_origin_fetch(&headers, &browser::IMAGE_DESTINATIONS);
    let _ = statics::accepted_encodings(browser::header(&headers, "accept-encoding").unwrap_or_default());
});
