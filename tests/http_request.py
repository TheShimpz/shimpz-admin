"""One in-memory ASGI HTTP request for Admin tests that call route handlers and gates directly."""

from __future__ import annotations

from typing import NamedTuple
from urllib.parse import unquote

from starlette.requests import Request


class Peer(NamedTuple):
    """The scheme, client address, and listener address a direct test request names."""

    scheme: str
    client: tuple[str, int]
    server: tuple[str, int | None]


# The loopback browser of a Local Space.
LOOPBACK = Peer("http", ("127.0.0.1", 1234), ("testserver", 80))


def remote(client_host: str) -> Peer:
    """A remote browser of the Hosted origin at one documentation-range address."""
    return Peer("https", (client_host, 1234), ("admin.example.test", 443))


def json_headers(body: bytes) -> list[tuple[bytes, bytes]]:
    return [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]


def _scope(
    method: str, path: str, raw_path: str, query: bytes, peer: Peer, headers: list[tuple[bytes, bytes]] | None
) -> dict[str, object]:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": peer.scheme,
        "path": path,
        "raw_path": raw_path.encode(),
        "query_string": query,
        "root_path": "",
        "headers": list(headers or []),
        "client": peer.client,
        "server": peer.server,
    }


def http_request(
    path: str,
    peer: Peer,
    *,
    method: str = "POST",
    body: bytes = b"",
    chunks: list[bytes] | None = None,
    headers: list[tuple[bytes, bytes]] | None = None,
    query: bytes = b"",
) -> Request:
    """Return a request whose body arrives once, or as the given chunks, and then reads as complete."""
    scope = _scope(method, path, path, query, peer, headers)
    pending = [body] if chunks is None else list(chunks)

    async def receive():
        if not pending:
            return {"type": "http.request", "body": b"", "more_body": False}
        chunk = pending.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(pending)}

    return Request(scope, receive)


class Exchange(NamedTuple):
    """The status, lower-cased headers, and body one ASGI exchange produced."""

    status: int
    headers: dict[str, str]
    body: bytes


async def asgi_exchange(
    application,
    path: str,
    peer: Peer,
    *,
    method: str = "GET",
    headers: list[tuple[bytes, bytes]] | None = None,
    unquote_path: bool = False,
) -> Exchange:
    """Drive one bodiless request through a whole ASGI application, then report the client as disconnected."""
    messages: list[dict] = []
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    scope = _scope(method, unquote(path) if unquote_path else path, path, b"", peer, headers)
    await application(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    return Exchange(
        start["status"],
        {key.decode().lower(): value.decode() for key, value in start["headers"]},
        b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body"),
    )
