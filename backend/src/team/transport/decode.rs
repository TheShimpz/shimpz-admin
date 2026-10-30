//! Reading Team's answers exactly as its protocol frames them: one JSON object, an NDJSON chat stream, an image, or a
//! file's verified original. Anything else is an invalid answer.

use std::time::Duration;

use data_encoding::{BASE64, HEXLOWER};
use sha2::{Digest, Sha256};
use team_protocol::{
    browser::MAX_TASK_SECONDS,
    content::{self as content_contract, MAX_CONTENT_BYTES},
    preview::{self, MAX_PREVIEW_BYTES, PAGE_COUNT_HEADER, SIGNATURES},
    progress::{self, MAX_EVENTS, MAX_LINE_BYTES, MAX_STREAM_BYTES},
};

use super::exchange::Response;
use crate::{
    fault::Reply,
    json::{self, Value},
};

/// The largest Assistant icon.
pub const MAX_ICON_BYTES: usize = 1024 * 1024;

/// Which image a binary read expects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Image {
    /// An Assistant icon: a PNG within 1 MiB.
    Icon,
    /// A file's preview: a JPEG or PNG within the preview bound, its bytes carrying its type's signature.
    Preview,
    /// A PDF page's preview, which also names its document's page count.
    PagePreview,
}

/// A binary answer: its bytes and media type, or Team's JSON refusal.
#[derive(Clone, Debug, PartialEq)]
pub struct AssetReply {
    /// The HTTP status.
    pub status: u16,
    /// The bytes, when Team sent them.
    pub contents: Option<Vec<u8>>,
    /// Team's refusal, when it sent none.
    pub error: Value,
    /// The bytes' media type.
    pub media_type: String,
    /// A PDF page preview's page count.
    pub page_count: Option<i64>,
}

impl AssetReply {
    pub(super) fn refused(status: u16, error: Value) -> Self {
        Self {
            status,
            contents: None,
            error,
            media_type: "image/png".to_owned(),
            page_count: None,
        }
    }

    /// Team could not answer: 502 `{"detail": "team unavailable"}`.
    #[must_use]
    pub fn unavailable() -> Self {
        Self::refused(502, json::detail("team unavailable"))
    }
}

fn media_type(response: &Response) -> String {
    response
        .header("content-type")
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// Team's one JSON object (never for a 204, which carries none).
pub(super) async fn json(
    response: &mut Response,
    limit: usize,
    timeout: Duration,
) -> Result<Value, ()> {
    if response.status.as_u16() == 204 || media_type(response) != "application/json" {
        return Err(());
    }
    if let Some(length) = response.header("content-length") {
        let length: i64 = length.trim().parse().map_err(|_| ())?;
        if length < 0 || usize::try_from(length).map_err(|_| ())? > limit {
            return Err(());
        }
    }
    let raw = response.read(limit, timeout).await?;
    let body = json::parse(&raw).map_err(|_| ())?;
    json::members(&body).ok_or(())?;
    Ok(body)
}

async fn refusal_or<F>(
    response: &mut Response,
    timeout: Duration,
    read: F,
) -> Result<AssetReply, ()>
where
    F: AsyncFnOnce(&mut Response) -> Result<AssetReply, ()>,
{
    let status = response.status.as_u16();
    if status != 200 {
        let error = json(response, super::MAX_JSON_RESPONSE_BYTES, timeout).await?;
        return Ok(AssetReply::refused(status, error));
    }
    read(response).await
}

fn exact_length(response: &Response, maximum: usize) -> Result<usize, ()> {
    let raw = response.header("content-length").ok_or(())?;
    let length: usize = raw.trim().parse().map_err(|_| ())?;
    if (1..=maximum).contains(&length) {
        Ok(length)
    } else {
        Err(())
    }
}

/// One exactly framed image, or Team's JSON refusal of it.
pub(super) async fn image(
    response: &mut Response,
    image: Image,
    timeout: Duration,
) -> Result<AssetReply, ()> {
    refusal_or(response, timeout, async |response: &mut Response| {
        let media_type = media_type(response);
        let (admitted, maximum): (&[&str], usize) = match image {
            Image::Icon => (&["image/png"], MAX_ICON_BYTES),
            Image::Preview | Image::PagePreview => {
                (&["image/jpeg", "image/png"], MAX_PREVIEW_BYTES)
            }
        };
        if !admitted.contains(&media_type.as_str()) {
            return Err(());
        }
        let length = exact_length(response, maximum)?;
        let contents = response.read(maximum, timeout).await?;
        if contents.len() != length {
            return Err(());
        }
        if image != Image::Icon {
            let signature = SIGNATURES
                .iter()
                .find(|(kind, _)| *kind == media_type)
                .map(|(_, signature)| *signature)
                .ok_or(())?;
            if !contents.starts_with(signature) {
                return Err(());
            }
        }
        let page_count = if image == Image::PagePreview {
            let header = response.header(PAGE_COUNT_HEADER).unwrap_or_default();
            Some(preview::canonical_page(&json::text(header)).ok_or(())?)
        } else {
            None
        };
        Ok(AssetReply {
            status: 200,
            contents: Some(contents),
            error: json::empty(),
            media_type,
            page_count,
        })
    })
    .await
}

fn repr_digest(header: &str) -> Option<String> {
    let encoded = header.strip_prefix("sha-256=:")?.strip_suffix(':')?;
    if encoded.len() != 44
        || !encoded.ends_with('=')
        || !encoded[..43]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return None;
    }
    let raw = BASE64.decode(encoded.as_bytes()).ok()?;
    (raw.len() == 32).then(|| HEXLOWER.encode(&raw))
}

/// A file's original: an octet stream of its declared length whose SHA-256 is its declared digest, read whole within
/// the upload bound and verified before any of it is sent on.
pub(super) async fn content(response: &mut Response, timeout: Duration) -> Result<AssetReply, ()> {
    refusal_or(response, timeout, async |response: &mut Response| {
        let raw_length = response
            .header("content-length")
            .unwrap_or_default()
            .to_owned();
        let digest = response.header("repr-digest").and_then(repr_digest);
        if media_type(response) != "application/octet-stream"
            || raw_length.is_empty()
            || !raw_length.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(());
        }
        let digest = digest.ok_or(())?;
        let length: i64 = raw_length.parse().map_err(|_| ())?;
        let framing = json::object(vec![
            ("length", json::int(length)),
            ("sha256", json::text(&digest)),
        ]);
        content_contract::canonical_framing(&framing).ok_or(())?;
        let contents = response
            .read(
                usize::try_from(MAX_CONTENT_BYTES).unwrap_or(usize::MAX),
                timeout,
            )
            .await?;
        if i64::try_from(contents.len()).ok() != Some(length)
            || HEXLOWER.encode(&Sha256::digest(&contents)) != digest
        {
            return Err(());
        }
        Ok(AssetReply {
            status: 200,
            contents: Some(contents),
            error: json::empty(),
            media_type: "application/octet-stream".to_owned(),
            page_count: None,
        })
    })
    .await
}

/// A chat turn's progress, then its terminal answer. Team may stay silent `timeout` between records; from a Browser
/// phase's validated start until its end, as long as that task may run and `timeout` more.
pub(super) async fn stream(
    response: &mut Response,
    progress_sink: &(dyn Fn(Value) + Send + Sync),
    timeout: Duration,
) -> Result<Reply, ()> {
    if response.status.as_u16() != 200
        || media_type(response) != "application/x-ndjson"
        || response.header("content-length").is_some()
        || response.header("transfer-encoding") != Some("chunked")
    {
        return Err(());
    }
    let browser = timeout + Duration::from_secs(MAX_TASK_SECONDS);
    let mut pace = timeout;
    let mut buffer: Vec<u8> = Vec::new();
    let (mut sequence, mut events, mut total) = (0_i64, 0_i64, 0_usize);
    loop {
        let line = next_line(response, &mut buffer, pace).await?;
        total += line.len();
        if total > MAX_STREAM_BYTES {
            return Err(());
        }
        let record = progress::decode_line(&line).map_err(|_| ())?;
        if json::get_str(&record, "type") == Some("terminal") {
            if !buffer.is_empty()
                || response
                    .chunk(timeout)
                    .await?
                    .is_some_and(|chunk| !chunk.is_empty())
            {
                return Err(());
            }
            let status = json::get(&record, "status")
                .and_then(json::as_int)
                .ok_or(())?;
            let body = json::get(&record, "body").cloned().ok_or(())?;
            return Ok(Reply::new(u16::try_from(status).map_err(|_| ())?, body));
        }
        events += 1;
        let seq = json::get(&record, "seq").and_then(json::as_int).ok_or(())?;
        if events > MAX_EVENTS || seq != sequence + 1 {
            return Err(());
        }
        sequence = seq;
        if json::get_str(&record, "phase") == Some("browser") {
            pace = if json::get_str(&record, "state") == Some("started") {
                browser
            } else {
                timeout
            };
        }
        progress_sink(json::without(&record, "type"));
    }
}

async fn next_line(
    response: &mut Response,
    buffer: &mut Vec<u8>,
    timeout: Duration,
) -> Result<Vec<u8>, ()> {
    loop {
        if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let rest = buffer.split_off(end + 1);
            return Ok(std::mem::replace(buffer, rest));
        }
        if buffer.len() > MAX_LINE_BYTES {
            return Err(());
        }
        match response.chunk(timeout).await? {
            Some(chunk) => buffer.extend_from_slice(&chunk),
            None => return Err(()),
        }
    }
}
