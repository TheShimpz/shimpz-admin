"""One in-memory ASGI HTTP request for Admin tests that call route handlers and gates directly."""

from __future__ import annotations

from typing import NamedTuple

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
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": peer.scheme,
        "path": path,
        "raw_path": path.encode(),
        "query_string": query,
        "root_path": "",
        "headers": list(headers or []),
        "client": peer.client,
        "server": peer.server,
    }
    pending = [body] if chunks is None else list(chunks)

    async def receive():
        if not pending:
            return {"type": "http.request", "body": b"", "more_body": False}
        chunk = pending.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(pending)}

    return Request(scope, receive)
