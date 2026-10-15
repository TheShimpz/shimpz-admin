"""One in-memory ASGI HTTP request for Admin tests that call route handlers and gates directly."""

import json
from typing import NamedTuple
from urllib.parse import unquote

from starlette.datastructures import Headers
from starlette.requests import Request


class Peer(NamedTuple):
    """The scheme, client address, and listener address a direct test request names."""

    scheme: str
    client: tuple[str, int]
    server: tuple[str, int | None]


# The loopback browser of a Local Space.
LOOPBACK = Peer("http", ("127.0.0.1", 1234), ("testserver", 80))


def remote(client_host: str) -> Peer:
    """A remote browser of an external HTTPS origin at one documentation-range address."""
    return Peer("https", (client_host, 1234), ("admin.example.test", 443))


def json_headers(body: bytes) -> list[tuple[bytes, bytes]]:
    return [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]


# The Admin page's own fetch: the browser marks every request it sends to its own origin.
SAME_ORIGIN = ((b"sec-fetch-site", b"same-origin"),)


def json_request(
    path: str,
    payload: object = None,
    *,
    peer: Peer = LOOPBACK,
    method: str | None = None,
    origin: str | None = None,
    cookies: dict[str, str] | None = None,
    browser: tuple[tuple[bytes, bytes], ...] = SAME_ORIGIN,
) -> Request:
    """Return a request to `path` (with any query) carrying `payload` as JSON, sent by the Admin page by default.

    It is a POST with a payload and a GET without one, unless `method` names another.
    """
    raw_path, _, query = path.partition("?")
    body = b"" if payload is None else json.dumps(payload).encode()
    headers = json_headers(body) if body else []
    if origin is not None:
        headers.append((b"origin", origin.encode("ascii")))
    if cookies:
        headers.append((b"cookie", "; ".join(f"{name}={value}" for name, value in cookies.items()).encode("ascii")))
    headers.extend(browser)
    return http_request(
        raw_path, peer, method=method or ("POST" if body else "GET"), body=body, headers=headers, query=query.encode()
    )


def response_cookie(response, name: str) -> str:
    """The value one response sets for cookie `name`."""
    prefix = name + "="
    return next(
        part.removeprefix(prefix) for part in response.headers["set-cookie"].split("; ") if part.startswith(prefix)
    )


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


class Gated(NamedTuple):
    """The status, headers, and body Admin's gate answered one request with."""

    status_code: int
    headers: Headers
    body: bytes


async def through_gate(admin_app, request: Request, route) -> Gated:
    """Pass one request through Admin's gate to a stand-in route (an async function from a request to a response)."""

    async def application(scope, receive, send) -> None:
        response = await route(Request(scope, receive))
        await response(scope, receive, send)

    messages: list[dict] = []

    async def send(message: dict) -> None:
        messages.append(message)

    await admin_app._gate(request.scope, request.receive, send, application)
    start = next(message for message in messages if message["type"] == "http.response.start")
    return Gated(
        start["status"],
        Headers(raw=start["headers"]),
        b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body"),
    )
