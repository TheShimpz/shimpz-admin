//! A browser stand-in: plain HTTP requests and `WebSockets` with exactly the headers a test gives.

use admin_backend::json::{self, Value};
use axum::http::{HeaderMap, Request};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;

/// One answer.
#[derive(Debug)]
pub struct Answer {
    /// The status.
    pub status: u16,
    /// The headers.
    pub headers: HeaderMap,
    /// The body.
    pub body: Vec<u8>,
}

impl Answer {
    /// The body as JSON.
    #[must_use]
    pub fn json(&self) -> Value {
        json::parse(&self.body).unwrap_or(Value::Null)
    }

    /// A header's first value.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// Sends one request to `base` + `path` with `headers` and `body`.
pub async fn send(
    base: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> Answer {
    let address = base.trim_start_matches("http://");
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", address);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = sender
        .send_request(request.body(Full::new(Bytes::from(body))).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Answer {
        status: parts.status.as_u16(),
        headers: parts.headers,
        body: body
            .collect()
            .await
            .map(|collected| collected.to_bytes().to_vec())
            .unwrap_or_default(),
    }
}
