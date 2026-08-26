"""Immutable challenge documents shared by Admin WebSocket contract suites."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import threading

TURN_ID = "a" * 32
CHALLENGE_ID = "b" * 32


class Socket:
    """Small in-memory ASGI WebSocket used by the chat contract suites."""

    def __init__(
        self,
        application,
        *,
        token: str = "",
        origin: str = "http://localhost:7777",
        protocols: list[str] | None = None,
        team_id: str = "team_1",
        fail_send_type: str = "",
    ) -> None:
        offered = ["shimpz.chat.v6"] if protocols is None else protocols
        headers = [(b"host", b"localhost:7777"), (b"origin", origin.encode("ascii"))]
        if offered:
            headers.append((b"sec-websocket-protocol", ", ".join(offered).encode("ascii")))
        if token:
            headers.append((b"cookie", f"shimpz_admin={token}".encode("ascii")))
        path = f"/api/teams/{team_id}/chat/ws"
        self._scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 7777),
            "subprotocols": offered,
            "state": {},
            "extensions": {},
        }
        self._application = application
        self._incoming: asyncio.Queue = asyncio.Queue()
        self._outgoing: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._fail_send_type = fail_send_type
        self.send_failed = threading.Event()

    async def _send(self, message: dict) -> None:
        if message.get("type") == "websocket.send" and "text" in message:
            event = json.loads(message["text"])
            if event.get("type") == self._fail_send_type:
                self.send_failed.set()
                raise RuntimeError("simulated peer send failure")
        await self._outgoing.put(message)

    async def start(self) -> dict:
        self._task = asyncio.create_task(self._application(self._scope, self._incoming.get, self._send))
        await self._incoming.put({"type": "websocket.connect"})
        return await self.next_message()

    async def next_message(self, wait_seconds: float = 1.0) -> dict:
        return await asyncio.wait_for(self._outgoing.get(), timeout=wait_seconds)

    async def next_json(self, wait_seconds: float = 1.0) -> dict:
        message = await self.next_message(wait_seconds)
        if message.get("type") != "websocket.send" or "text" not in message:
            raise AssertionError(f"expected a text WebSocket frame, got {message!r}")
        return json.loads(message["text"])

    async def send_text(self, text: str) -> None:
        await self._incoming.put({"type": "websocket.receive", "text": text})

    async def send_bytes(self, value: bytes) -> None:
        await self._incoming.put({"type": "websocket.receive", "bytes": value})

    async def send_json(self, value: object) -> None:
        await self.send_text(json.dumps(value, separators=(",", ":")))

    async def disconnect(self) -> None:
        await self._incoming.put({"type": "websocket.disconnect", "code": 1000})
        await self.finish()

    async def finish(self) -> None:
        if self._task is not None:
            await asyncio.wait_for(self._task, timeout=2)


async def wait_for_thread(event: threading.Event, wait_seconds: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not event.is_set():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("worker did not start")
        await asyncio.sleep(0.005)


def integration_requirements() -> list[dict[str, object]]:
    return [
        {
            "assistant_id": "social-publisher",
            "assistant_name": "Social Publisher",
            "integration_id": "x-integration",
            "provider": "x",
            "name": "X integration",
            "summary": "Lets approved Actions access the connected X integration.",
            "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
            "actions": [
                {"id": "profile-me", "name": "Read profile", "summary": "Read the connected X profile."},
                {"id": "create-post", "name": "Create post", "summary": "Publish a post on X."},
            ],
        }
    ]


def integration_challenge(status: int = 428) -> object:
    local_module = importlib.import_module("chat.local")
    return local_module.PublicResponse(
        status,
        {
            "team_id": "team_1",
            "status": "integrations-required",
            "turn_id": TURN_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": integration_requirements(),
        },
    )


def human_challenge(kind: str, status: int = 428) -> object:
    local_module = importlib.import_module("chat.local")
    request: dict[str, object] = {
        "kind": kind,
        "ordinal": 0,
        "title": "Confirm this Action",
        "description": "The Action is waiting for your response.",
    }
    if kind == "input:password":
        request.update(
            label="API secret",
            required=True,
            placeholder="Enter the secret",
            min_length=1,
            max_length=1024,
        )
    canonical = json.dumps(
        request,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    request["fingerprint"] = hashlib.sha256(canonical).hexdigest()
    return local_module.PublicResponse(
        status,
        {
            "team_id": "team_1",
            "status": "human-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "assistant": {"id": "shimpz-cloudflare", "name": "Shimpz Cloudflare", "version": "0.4.1"},
            "action": {"id": "list-zones", "summary": "List reviewed Cloudflare zones."},
            "request": request,
        },
    )
