//! Admin's outbound HTTPS GETs to fixed public hosts (the Store catalog and icons, provider key probes): TLS verified
//! against the system roots, no redirect followed, no proxy, each on its own connection within one timeout per step.

use std::{sync::Arc, time::Duration};

use bytes::Bytes;
use http::{HeaderMap, Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;

use crate::config::Outbound;

/// An outbound request failed: unreachable, refused by TLS, too slow, or answered outside its bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failed;

/// One answer: its status, headers, and a body read within its bound.
pub struct Fetched {
    /// The HTTP status.
    pub status: StatusCode,
    /// The response headers.
    pub headers: HeaderMap,
    body: Incoming,
    timeout: Duration,
}

impl Fetched {
    /// A header's value as text.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The body, failing beyond `limit` bytes or a silence beyond the timeout.
    ///
    /// # Errors
    ///
    /// Returns [`Failed`] for a body that is too long, cut short, or too slow.
    pub async fn read(mut self, limit: usize) -> Result<Vec<u8>, Failed> {
        let mut body = Vec::new();
        loop {
            let frame = tokio::time::timeout(self.timeout, self.body.frame())
                .await
                .map_err(|_| Failed)?;
            match frame {
                None => return Ok(body),
                Some(Err(_)) => return Err(Failed),
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        body.extend_from_slice(&data);
                        if body.len() > limit {
                            return Err(Failed);
                        }
                    }
                }
            }
        }
    }
}

/// The outbound client: where its requests go and the TLS roots it trusts.
pub struct Client {
    target: Outbound,
    tls: Arc<rustls::ClientConfig>,
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap_or_else(|_| {
            unreachable!("the ring provider supports the default protocol versions")
        })
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

impl Client {
    /// A client sending to `target`.
    #[must_use]
    pub fn new(target: Outbound) -> Self {
        Self {
            target,
            tls: tls_config(),
        }
    }

    /// `GET https://{host}{path}` with `headers`, within `timeout` per step.
    ///
    /// # Errors
    ///
    /// Returns [`Failed`] when the host cannot be reached, TLS fails, or no answer comes in time.
    pub async fn get(
        &self,
        host: &str,
        path: &str,
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Fetched, Failed> {
        let request = headers
            .iter()
            .fold(
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .header("Host", host),
                |request, (name, value)| request.header(*name, *value),
            )
            .body(Empty::<Bytes>::new())
            .map_err(|_| Failed)?;
        let response = match &self.target {
            Outbound::Internet => {
                let stream =
                    tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, 443)))
                        .await
                        .map_err(|_| Failed)?
                        .map_err(|_| Failed)?;
                let name = ServerName::try_from(host.to_owned()).map_err(|_| Failed)?;
                let connector = tokio_rustls::TlsConnector::from(Arc::clone(&self.tls));
                let tls = tokio::time::timeout(timeout, connector.connect(name, stream))
                    .await
                    .map_err(|_| Failed)?
                    .map_err(|_| Failed)?;
                send(TokioIo::new(tls), request, timeout).await?
            }
            Outbound::Local(address) => {
                let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address))
                    .await
                    .map_err(|_| Failed)?
                    .map_err(|_| Failed)?;
                send(TokioIo::new(stream), request, timeout).await?
            }
        };
        let (parts, body) = response.into_parts();
        Ok(Fetched {
            status: parts.status,
            headers: parts.headers,
            body,
            timeout,
        })
    }
}

async fn send<T>(
    io: T,
    request: Request<Empty<Bytes>>,
    timeout: Duration,
) -> Result<http::Response<Incoming>, Failed>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, connection) =
        tokio::time::timeout(timeout, hyper::client::conn::http1::handshake(io))
            .await
            .map_err(|_| Failed)?
            .map_err(|_| Failed)?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    tokio::time::timeout(timeout, sender.send_request(request))
        .await
        .map_err(|_| Failed)?
        .map_err(|_| Failed)
}
