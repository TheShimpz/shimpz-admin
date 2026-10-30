use std::fmt::Write as _;

use axum::http::HeaderValue;

use super::*;

const BOUNDARY: &str = "XyZ";

type PartSpec<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a str);

fn multipart(parts: &[PartSpec<'_>]) -> Vec<u8> {
    let mut body = String::new();
    for (name, filename, media, content) in parts {
        let filename =
            filename.map_or_else(String::new, |filename| format!("; filename=\"{filename}\""));
        let media = media.map_or_else(String::new, |media| format!("Content-Type: {media}\r\n"));
        let _ = write!(
            body,
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"{filename}\r\n{media}\r\n{content}\r\n"
        );
    }
    let _ = write!(body, "--{BOUNDARY}--\r\n");
    body.into_bytes()
}

async fn upload_of(body: Vec<u8>) -> Result<(String, String, Bytes), Fault> {
    let request = Request::builder()
        .header(
            "content-type",
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(body))
        .unwrap();
    bounded_multipart_file(request).await
}

fn detail(fault: &Fault) -> (u16, Value) {
    let reply = fault.reply();
    (reply.status, reply.body)
}

async fn refusal(parts: &[PartSpec<'_>]) -> (u16, Value) {
    detail(&upload_of(multipart(parts)).await.unwrap_err())
}

fn refused(status: u16, text: &str) -> (u16, Value) {
    (status, json::detail(text))
}

#[tokio::test]
async fn exactly_one_file_part_named_file_is_an_upload() {
    let (name, media, content) = upload_of(multipart(&[(
        "file",
        Some("notes.txt"),
        Some("text/plain"),
        "hello",
    )]))
    .await
    .unwrap();
    assert_eq!(
        (name.as_str(), media.as_str(), &content[..]),
        ("notes.txt", "text/plain", &b"hello"[..])
    );
    let only = "multipart body must contain only one file field";
    assert_eq!(
        refusal(&[("other", Some("a.txt"), Some("text/plain"), "x")]).await,
        refused(400, only)
    );
    assert_eq!(refusal(&[]).await, refused(400, only));
}

#[tokio::test]
async fn a_field_a_second_file_or_a_broken_body_is_an_invalid_multipart_body() {
    let invalid = refused(400, "invalid multipart body");
    assert_eq!(refusal(&[("file", None, None, "x")]).await, invalid);
    let two = [
        ("file", Some("a.txt"), Some("text/plain"), "x"),
        ("file", Some("b.txt"), Some("text/plain"), "y"),
    ];
    assert_eq!(refusal(&two).await, invalid);
    assert_eq!(
        detail(&upload_of(b"garbage".to_vec()).await.unwrap_err()),
        invalid
    );
}

#[tokio::test]
async fn an_upload_s_name_type_and_size_are_team_s_own() {
    assert_eq!(
        refusal(&[("file", Some("../x"), Some("text/plain"), "x")]).await,
        refused(400, "filename must be a trimmed, non-path UTF-8 name")
    );
    assert_eq!(
        refusal(&[("file", Some("a.txt"), Some("not a type"), "x")]).await,
        refused(400, "invalid media type")
    );
    let (_, media, _) = upload_of(multipart(&[("file", Some("a.txt"), None, "x")]))
        .await
        .unwrap();
    assert_eq!(media, "application/octet-stream");
    assert_eq!(
        refusal(&[("file", Some("a.txt"), Some("text/plain"), "")]).await,
        refused(400, "file must contain bytes")
    );
}

#[test]
fn the_upload_s_headers_are_checked_before_its_body() {
    let mut headers = HeaderMap::new();
    assert_eq!(detail(&content_type(&headers).unwrap_err()).0, 415);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("multipart/form-data; boundary=x"),
    );
    assert!(content_type(&headers).is_ok());
    headers.append(
        header::CONTENT_TYPE,
        HeaderValue::from_static("multipart/form-data; boundary=y"),
    );
    assert_eq!(detail(&content_type(&headers).unwrap_err()).0, 415);
    let mut lengths = HeaderMap::new();
    lengths.insert(header::CONTENT_LENGTH, HeaderValue::from_static("12a"));
    assert_eq!(
        detail(&content_length(&lengths).unwrap_err()),
        refused(400, "invalid content length")
    );
    lengths.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(multipart_limit() + 1),
    );
    assert_eq!(
        detail(&content_length(&lengths).unwrap_err()),
        refused(413, "file upload too large")
    );
}
