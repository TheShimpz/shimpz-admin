//! One Team exchange over its own connection, sent again once with a re-read bearer when Team refuses the cached one.

use std::time::Duration;

use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;

use super::{Options, Reading, Team, decode, headers::Entity};
use crate::fault::Reply;

/// What one exchange ended with.
pub(super) enum Answer {
    /// A JSON answer, Team's own or Admin's 502.
    Json(Reply),
    /// A binary answer or Team's JSON refusal of it.
    Asset(decode::AssetReply),
    /// Team could not answer within its contract.
    Unavailable,
}

impl Answer {
    pub(super) fn into_reply(self) -> Reply {
        match self {
            Self::Json(reply) => reply,
            Self::Asset(asset) => Reply::new(asset.status, asset.error),
            Self::Unavailable => super::unavailable(),
        }
    }

    pub(super) fn into_asset(self) -> decode::AssetReply {
        match self {
            Self::Asset(asset) => asset,
            Self::Json(reply) => decode::AssetReply::refused(reply.status, reply.body),
            Self::Unavailable => decode::AssetReply::unavailable(),
        }
    }
}

/// The response head and body, read frame by frame within a silence bound.
pub(super) struct Response {
    pub(super) status: StatusCode,
    pub(super) headers: http::HeaderMap,
    body: Incoming,
}

impl Response {
    /// The header's first value, without parameters' case changed.
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The next chunk of the body, `None` at its end; an error or a silence beyond `timeout` fails.
    pub(super) async fn chunk(&mut self, timeout: Duration) -> Result<Option<Bytes>, ()> {
        loop {
            let frame = tokio::time::timeout(timeout, self.body.frame())
                .await
                .map_err(|_| ())?;
            match frame {
                None => return Ok(None),
                Some(Err(_)) => return Err(()),
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        return Ok(Some(data));
                    }
                }
            }
        }
    }

    /// The whole body of at most `limit` bytes; one byte more fails.
    pub(super) async fn read(&mut self, limit: usize, timeout: Duration) -> Result<Vec<u8>, ()> {
        let mut body = Vec::new();
        while let Some(chunk) = self.chunk(timeout).await? {
            body.extend_from_slice(&chunk);
            if body.len() > limit {
                return Err(());
            }
        }
        Ok(body)
    }
}

impl Team {
    pub(super) async fn exchange(
        &self,
        method: &str,
        path: &str,
        entity: &Entity<'_>,
        options: &Options,
        reading: &Reading<'_>,
    ) -> Answer {
        if let Some(answer) = self
            .exchange_once(method, path, entity, options, reading)
            .await
        {
            return answer;
        }
        self.client.forget_token();
        self.exchange_once(method, path, entity, options, reading)
            .await
            .unwrap_or(Answer::Unavailable)
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        entity: &Entity<'_>,
        options: &Options,
        accept: &str,
    ) -> Result<Response, ()> {
        let (host, port) = self.client.endpoint.clone().ok_or(())?;
        let headers = self.request_headers(method, path, entity, accept, &options.bindings)?;
        let stream = tokio::time::timeout(
            options.timeout,
            tokio::net::TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|_| ())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("Host", format!("{host}:{port}"));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let body = Full::new(Bytes::copy_from_slice(entity.body.unwrap_or_default()));
        let request = request.body(body).map_err(|_| ())?;
        let response = tokio::time::timeout(options.timeout, sender.send_request(request))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        let (parts, body) = response.into_parts();
        Ok(Response {
            status: parts.status,
            headers: parts.headers,
            body,
        })
    }

    /// One exchange; `None` when Team refused the bearer, and unavailable on any other failure.
    async fn exchange_once(
        &self,
        method: &str,
        path: &str,
        entity: &Entity<'_>,
        options: &Options,
        reading: &Reading<'_>,
    ) -> Option<Answer> {
        let accept = match reading {
            Reading::Json(_) => "application/json",
            Reading::Stream(_) => "application/x-ndjson",
            Reading::Image(decode::Image::Icon) => "image/png",
            Reading::Image(_) => "image/jpeg, image/png",
            Reading::Content => "application/octet-stream",
        };
        let Ok(mut response) = self.send(method, path, entity, options, accept).await else {
            return Some(Answer::Unavailable);
        };
        let status = response.status.as_u16();
        if !(200..=599).contains(&status) {
            return Some(Answer::Unavailable);
        }
        if status == 401 {
            return match decode::json(
                &mut response,
                super::MAX_JSON_RESPONSE_BYTES,
                options.timeout,
            )
            .await
            {
                Ok(body)
                    if crate::json::get_str(&body, "error") == Some("authentication required") =>
                {
                    None
                }
                _ => Some(Answer::Unavailable),
            };
        }
        let answer = read_answer(&mut response, status, reading, options.timeout).await;
        Some(answer.unwrap_or(Answer::Unavailable))
    }
}

async fn read_answer(
    response: &mut Response,
    status: u16,
    reading: &Reading<'_>,
    timeout: Duration,
) -> Result<Answer, ()> {
    match reading {
        Reading::Json(limit) => decode::json(response, *limit, timeout)
            .await
            .map(|body| Answer::Json(Reply::new(status, body))),
        Reading::Stream(progress) => decode::stream(response, *progress, timeout)
            .await
            .map(Answer::Json),
        Reading::Image(image) => decode::image(response, *image, timeout)
            .await
            .map(Answer::Asset),
        Reading::Content => decode::content(response, timeout).await.map(Answer::Asset),
    }
}
