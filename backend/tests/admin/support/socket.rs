//! A browser's WebSocket: the handshake with exactly the headers a test gives, then JSON text frames.

use admin_backend::json::{self, Value};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest, protocol::CloseFrame},
};

/// An open WebSocket.
pub type Socket = WebSocketStream<tokio::net::TcpStream>;

/// Opens a WebSocket to `path` with `headers`; the handshake's HTTP status when it is refused.
pub async fn connect(base: &str, path: &str, headers: &[(&str, &str)]) -> Result<Socket, u16> {
    let address = base.trim_start_matches("http://");
    let mut request = format!("ws://{address}{path}")
        .into_client_request()
        .unwrap();
    for (name, value) in headers {
        request.headers_mut().insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    match tokio_tungstenite::client_async(request, stream).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(_) => Err(0),
    }
}

/// Sends one JSON text frame.
pub async fn send_frame(socket: &mut Socket, frame: &Value) {
    socket
        .send(Message::text(json::compact(frame)))
        .await
        .unwrap();
}

/// The next text frame as JSON, or the close code once the socket closed.
pub async fn next(socket: &mut Socket) -> Result<Value, u16> {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(10), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => return Ok(json::parse(text.as_bytes()).unwrap()),
            Ok(Some(Ok(Message::Close(frame)))) => {
                return Err(frame.map_or(1005, |CloseFrame { code, .. }| u16::from(code)));
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) => return Err(1006),
            Err(_) => return Err(0),
        }
    }
}
