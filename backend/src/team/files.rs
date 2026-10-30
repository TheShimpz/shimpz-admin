//! A Team's files over HTTP: the upload, a file's previews, and its download (ADR-0093).

use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, header},
    response::Response,
};
use team_protocol::payload::MAX_FILE_UPLOAD_BYTES;
use tokio::sync::OwnedSemaphorePermit;

use super::{
    bridge,
    transport::{AssetReply, Team},
};
use crate::{
    fault::{Fault, Outcome},
    http::{body, browser, respond},
    json::{self, Value},
    process::app::App,
    sync::lock,
};

/// The multipart framing a file upload may add to its file.
pub const MAX_MULTIPART_OVERHEAD_BYTES: usize = 64 * 1024;
/// At most this many originals are held to be sent at once.
pub const MAX_DOWNLOADS: usize = 2;
/// A browser that has not taken a download within this long of its start is cut off.
pub const DOWNLOAD_SEND: Duration = Duration::from_secs(120);
/// The retry hint of a busy download.
pub const DOWNLOAD_RETRY_MS: i64 = 250;
const CHUNK_BYTES: usize = 64 * 1024;

fn upload_limit() -> usize {
    usize::try_from(MAX_FILE_UPLOAD_BYTES).unwrap_or(usize::MAX)
}

fn multipart_limit() -> usize {
    upload_limit() + MAX_MULTIPART_OVERHEAD_BYTES
}

fn no_store(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

fn json_no_store(status: u16, body: &Value) -> Response {
    let mut response = respond::json_response(status, body);
    no_store(&mut response);
    response
}

fn refused_origin() -> Response {
    json_no_store(403, &json::detail("browser origin is not admitted"))
}

/// The Team handle the gate bound this request to.
fn team_of(request: &Request) -> Result<Team, Fault> {
    request
        .extensions()
        .get::<Team>()
        .cloned()
        .ok_or(Fault::Authority)
}

fn content_type(headers: &HeaderMap) -> Result<String, Fault> {
    let sent: Vec<&HeaderValue> = headers.get_all(header::CONTENT_TYPE).iter().collect();
    let value = match sent.as_slice() {
        [value] => value.to_str().unwrap_or_default(),
        _ => "",
    };
    let base = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if base == "multipart/form-data" {
        Ok(value.to_owned())
    } else {
        Err(Fault::detail(
            415,
            "content type must be multipart/form-data",
        ))
    }
}

fn content_length(headers: &HeaderMap) -> Result<(), Fault> {
    let sent: Vec<&HeaderValue> = headers.get_all(header::CONTENT_LENGTH).iter().collect();
    match sent.as_slice() {
        [] => Ok(()),
        [value] => {
            let text = value.to_str().unwrap_or("x");
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(Fault::detail(400, "invalid content length"));
            }
            let fits = text
                .parse::<usize>()
                .is_ok_and(|length| length <= multipart_limit());
            if fits {
                Ok(())
            } else {
                Err(Fault::detail(413, "file upload too large"))
            }
        }
        _ => Err(Fault::detail(400, "invalid content length")),
    }
}

/// One file part as the upload carries it: its field name, filename, part media type, and bytes.
struct Part {
    name: Option<String>,
    filename: String,
    media_type: Value,
    content: Bytes,
}

fn invalid_multipart() -> Fault {
    Fault::detail(400, "invalid multipart body")
}

/// Every part of the body; any part that is not a file, or a second file, is an invalid body.
async fn parts(content_type: &str, raw: Vec<u8>) -> Result<Vec<Part>, Fault> {
    let boundary = multer::parse_boundary(content_type).map_err(|_| invalid_multipart())?;
    let stream = futures_util::stream::once(async move { Ok::<_, Infallible>(Bytes::from(raw)) });
    let mut multipart = multer::Multipart::new(stream, boundary);
    let mut found = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| invalid_multipart())?
    {
        let Some(filename) = field.file_name().map(str::to_owned) else {
            return Err(invalid_multipart());
        };
        if !found.is_empty() {
            return Err(invalid_multipart());
        }
        let name = field.name().map(str::to_owned);
        let media_type = field
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map_or(Value::Null, json::text);
        let content = field.bytes().await.map_err(|_| invalid_multipart())?;
        found.push(Part {
            name,
            filename,
            media_type,
            content,
        });
    }
    Ok(found)
}

/// Accepts exactly one bounded file part and returns its canonical name, media type, and bytes.
async fn bounded_multipart_file(request: Request) -> Result<(String, String, Bytes), Fault> {
    let content_type = content_type(request.headers())?;
    content_length(request.headers())?;
    let raw = body::read(request.into_body(), multipart_limit())
        .await
        .map_err(|fault| match fault {
            Fault::Refused(refusal) if refusal.status == 413 => {
                Fault::detail(413, "file upload too large")
            }
            other => other,
        })?;
    let mut found = parts(&content_type, raw).await?;
    let part = match (found.pop(), found.is_empty()) {
        (Some(part), true) if part.name.as_deref() == Some("file") => part,
        _ => {
            return Err(Fault::detail(
                400,
                "multipart body must contain only one file field",
            ));
        }
    };
    let filename = team_protocol::payload::canonical_filename(&json::text(&part.filename))
        .map(str::to_owned)
        .ok_or_else(|| Fault::detail(400, "filename must be a trimmed, non-path UTF-8 name"))?;
    let media_type = team_protocol::payload::canonical_media_type(&part.media_type)
        .ok_or_else(|| Fault::detail(400, "invalid media type"))?;
    if part.content.is_empty() {
        return Err(Fault::detail(400, "file must contain bytes"));
    }
    if part.content.len() > upload_limit() {
        return Err(Fault::detail(413, "file upload too large"));
    }
    Ok((filename, media_type, part.content))
}

async fn uploaded(team_id: &str, request: Request) -> Outcome {
    let team = team_of(&request)?;
    let (filename, media_type, content) = bounded_multipart_file(request).await?;
    bridge::upload_file(&team, team_id, &filename, &media_type, &content)
        .await
        .map_err(Fault::bad_request)
}

/// `POST /api/teams/{team_id}/files`.
pub async fn upload(Path(team_id): Path<String>, request: Request) -> Response {
    respond::outcome(uploaded(&team_id, request).await)
}

fn rendition(result: AssetReply, page_count: Option<i64>) -> Response {
    let Some(contents) = result.contents else {
        return json_no_store(result.status, &result.error);
    };
    let mut response = Response::new(Body::from(contents));
    no_store(&mut response);
    if let Ok(value) = HeaderValue::from_str(&result.media_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    if let Some(count) = page_count {
        response.headers_mut().insert(
            HeaderName::from_static("x-page-count"),
            HeaderValue::from(count),
        );
    }
    response
}

/// `GET /api/teams/{team_id}/files/{file_id}/preview`: a sanitized image rendition for Admin's own page, never cached.
pub async fn preview(
    Path((team_id, file_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    if !browser::same_origin_fetch(request.headers(), &browser::IMAGE_DESTINATIONS) {
        return refused_origin();
    }
    let team = team_of(&request);
    drop(request);
    let result = async {
        bridge::file_preview(&team?, &team_id, &file_id)
            .await
            .map_err(Fault::bad_request)
    }
    .await;
    match result {
        Ok(result) => rendition(result, None),
        Err(fault) => respond::fault(&fault),
    }
}

/// `GET /api/teams/{team_id}/files/{file_id}/pages/{page}/preview`: one page of a Team PDF, with its page count.
pub async fn page_preview(
    Path((team_id, file_id, page)): Path<(String, String, String)>,
    request: Request,
) -> Response {
    if !browser::same_origin_fetch(request.headers(), &browser::IMAGE_DESTINATIONS) {
        return refused_origin();
    }
    let team = team_of(&request);
    drop(request);
    let result = async {
        bridge::file_page_preview(&team?, &team_id, &file_id, &page)
            .await
            .map_err(Fault::bad_request)
    }
    .await;
    match result {
        Ok(result) => {
            let count = result.page_count;
            rendition(result, count)
        }
        Err(fault) => respond::fault(&fault),
    }
}

/// A held download slot, released once: when the response ends, or when the browser did not take it in time.
type Slot = Arc<Mutex<Option<OwnedSemaphorePermit>>>;

/// The original sent as an attachment in bounded chunks, holding its slot until it ends or its deadline passes.
fn attachment(contents: Vec<u8>, slot: Slot) -> Response {
    let deadline = tokio::time::Instant::now() + DOWNLOAD_SEND;
    let timer = Arc::clone(&slot);
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        lock(&timer).take();
    });
    let chunks: Vec<Bytes> = Bytes::from(contents)
        .chunks(CHUNK_BYTES)
        .map(Bytes::copy_from_slice)
        .collect();
    let stream = futures_util::stream::unfold(
        (chunks.into_iter(), slot),
        move |(mut chunks, slot)| async move {
            if tokio::time::Instant::now() >= deadline {
                lock(&slot).take();
                return Some((
                    Err(std::io::Error::other("download send deadline")),
                    (chunks, slot),
                ));
            }
            if let Some(chunk) = chunks.next() {
                return Some((Ok(chunk), (chunks, slot)));
            }
            lock(&slot).take();
            None
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    no_store(&mut response);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    response
}

fn busy() -> Response {
    json_no_store(
        503,
        &json::object(vec![
            ("detail", json::text("file download unavailable")),
            ("code", json::text("file-download-busy")),
            ("retry_after_ms", json::int(DOWNLOAD_RETRY_MS)),
        ]),
    )
}

/// `GET /api/teams/{team_id}/files/{file_id}/download`: one Team file's original for the Supervisor to save.
///
/// Only Admin's own page reaches it. Team verifies the bytes against their digest and Admin verifies them again before
/// sending any; at most [`MAX_DOWNLOADS`] are held at once, each from before Team is asked until its response ended.
pub async fn download(
    State(app): State<Arc<App>>,
    Path((team_id, file_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    if !browser::same_origin_fetch(request.headers(), &browser::DOWNLOAD_DESTINATIONS) {
        return refused_origin();
    }
    let Ok(permit) = Arc::clone(&app.domains.team.downloads).try_acquire_owned() else {
        return busy();
    };
    let team = team_of(&request);
    drop(request);
    let result = async {
        bridge::file_content(&team?, &team_id, &file_id)
            .await
            .map_err(Fault::bad_request)
    }
    .await;
    match result {
        Ok(AssetReply {
            contents: Some(contents),
            ..
        }) => attachment(contents, Arc::new(Mutex::new(Some(permit)))),
        Ok(refused) => json_no_store(refused.status, &refused.error),
        Err(fault) => respond::fault(&fault),
    }
}

#[cfg(test)]
mod tests;
