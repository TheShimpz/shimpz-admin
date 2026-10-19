"""Immutable challenge documents shared by Admin WebSocket contract suites."""

import asyncio
import importlib
import json
import threading
from collections.abc import Callable
from unittest import mock

from tests import localized_request

TURN_ID = "a" * 32
# How long a test waits for a frame or worker it expects. CI runs every lane on all processors, where a one-second
# wait timed out on a correct frame; checks that nothing arrives pass their own short wait instead.
EXPECTED_FRAME_SECONDS = 10.0
CHALLENGE_ID = "b" * 32


def chat_frame(
    message: str,
    assistant_ids: list[str] | None = None,
    *,
    locale: str | None = "en",
) -> dict[str, object]:
    """Return one complete chat frame with no files and no timezone, as the Admin client sends it."""
    return {
        "type": "chat",
        "message": message,
        "files": [],
        "assistant_ids": [] if assistant_ids is None else assistant_ids,
        "locale": locale,
        "timezone": None,
    }


def resume_frame(
    objective: str = "Lista minhas zonas DNS no Cloudflare", assistant_ids: list[str] | None = None
) -> dict[str, object]:
    """Return one complete resume-task frame asking Admin to enable what the prior objective needs."""
    ids = [] if assistant_ids is None else assistant_ids
    return {
        "type": "resume-task",
        "message": "Você mesmo consegue habilitar?",
        "objective": objective,
        "files": [],
        "assistant_ids": list(ids),
        "objective_assistant_ids": list(ids),
        "locale": "en",
        "timezone": None,
    }


def human_response(value: object, *, challenge_id: str = CHALLENGE_ID) -> dict[str, object]:
    """Return one submitted human-response frame, as the Admin client sends it."""
    return {"type": "human-response", "challenge_id": challenge_id, "decision": "submit", "value": value}


# The v7 server frames whose own shape names their Team; every other chat frame carries `team_id` only on the session
# socket's chat channel, so the fixture strips it after checking it, and suites compare the exact v7 frame.
_NATIVE_TEAM_FRAMES = frozenset({"done", "assistant-install-plan", "assistant-guidance"})
_NATIVE_UNINSTALL_STATES = frozenset({"proposed", "uninstalled"})
CHAT_CLIENT_TYPES = frozenset({"chat", "resume-task", "stop", "sync", "human-response"})


def v7_event(frame: dict[str, object], team_id: str) -> dict[str, object]:
    """The `shimpz.chat.v7` frame a channel frame carries, after proving it names the attached Team."""
    if frame.get("team_id") != team_id:
        raise AssertionError(f"chat frame names another Team: {frame!r}")
    native = frame.get("type") in _NATIVE_TEAM_FRAMES or (
        frame.get("type") == "assistant-uninstall" and frame.get("state") in _NATIVE_UNINSTALL_STATES
    )
    return frame if native else {key: value for key, value in frame.items() if key != "team_id"}


class Socket:
    """Small in-memory ASGI client of the Admin session socket, attached to one Team's chat channel.

    `send_json` adds the attached Team's `team_id` to a chat frame, and `next_json` checks and strips it again, so a
    chat suite reads the exact `shimpz.chat.v7` frames; `next_frame` returns any frame as Admin sent it.
    """

    def __init__(
        self,
        application,
        *,
        token: str = "",
        origin: str | None = "http://localhost:7777",
        protocols: list[str] | None = None,
        team_id: str = "team_1",
        fail_send_type: str = "",
        headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        offered = ["shimpz.admin.v1"] if protocols is None else protocols
        sent = [(b"host", b"localhost:7777")]
        if origin is not None:
            sent.append((b"origin", origin.encode("ascii")))
        if offered:
            sent.append((b"sec-websocket-protocol", ", ".join(offered).encode("ascii")))
        if token:
            sent.append((b"cookie", f"shimpz_admin={token}".encode("ascii")))
        sent.extend(headers or ())
        path = "/api/session/ws"
        self.team_id = team_id
        self._scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "root_path": "",
            "headers": sent,
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
        self._calls = 0
        self.deadlines: list[dict] = []
        # The long calls Admin said had started running, in order.
        self.progress: list[str] = []
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

    async def next_message(self, wait_seconds: float = EXPECTED_FRAME_SECONDS) -> dict:
        """The next message, past the session deadlines Admin tells the page, which `deadlines` keeps in order."""
        while True:
            message = await asyncio.wait_for(self._outgoing.get(), timeout=wait_seconds)
            if (
                message.get("type") == "websocket.send"
                and json.loads(message.get("text") or "{}").get("type") == "session"
            ):
                self.deadlines.append(json.loads(message["text"]))
                continue
            return message

    async def next_session(self, wait_seconds: float = EXPECTED_FRAME_SECONDS) -> dict:
        """The next session deadlines Admin told the page, whichever frames came before them."""
        while not self.deadlines:
            message = await asyncio.wait_for(self._outgoing.get(), timeout=wait_seconds)
            frame = json.loads(message["text"]) if message.get("type") == "websocket.send" else None
            if frame is None or frame.get("type") != "session":
                raise AssertionError(f"expected the session's deadlines, got {message!r}")
            self.deadlines.append(frame)
        return self.deadlines.pop(0)

    async def next_frame(self, wait_seconds: float = EXPECTED_FRAME_SECONDS) -> dict:
        """The next frame exactly as Admin sent it."""
        message = await self.next_message(wait_seconds)
        if message.get("type") != "websocket.send" or "text" not in message:
            raise AssertionError(f"expected a text WebSocket frame, got {message!r}")
        return json.loads(message["text"])

    async def next_json(self, wait_seconds: float = EXPECTED_FRAME_SECONDS) -> dict:
        """The next frame, a chat frame as the exact v7 frame it carries."""
        frame = await self.next_frame(wait_seconds)
        return frame if frame.get("type") in {"result", "changed"} else v7_event(frame, self.team_id)

    async def send_text(self, text: str) -> None:
        await self._incoming.put({"type": "websocket.receive", "text": text})

    async def send_bytes(self, value: bytes) -> None:
        await self._incoming.put({"type": "websocket.receive", "bytes": value})

    async def send_json(self, value: object) -> None:
        if isinstance(value, dict) and value.get("type") in CHAT_CLIENT_TYPES and "team_id" not in value:
            value = {**value, "team_id": self.team_id}
        await self.send_text(json.dumps(value, separators=(",", ":")))

    async def call(self, method: str, params: dict[str, object]) -> str:
        """Send one call and return its id."""
        self._calls += 1
        call_id = f"call-{self._calls}"
        await self.send_json({"type": "call", "id": call_id, "method": method, "params": params})
        return call_id

    async def result(
        self, method: str, params: dict[str, object], wait_seconds: float = EXPECTED_FRAME_SECONDS
    ) -> dict:
        """Call one method and return its result, which must be the next frame past the call's own `progress`."""
        call_id = await self.call(method, params)
        frame = await self.next_frame(wait_seconds)
        if frame == {"type": "progress", "id": call_id, "state": "running"}:
            self.progress.append(call_id)
            frame = await self.next_frame(wait_seconds)
        if frame.get("type") != "result" or frame.get("id") != call_id:
            raise AssertionError(f"expected the result of {call_id}, got {frame!r}")
        return frame

    async def attach(self, locale: str = "en", *, synchronized: bool = True) -> None:
        """Attach the Team's chat channel and read its result and the empty sync it then performs.

        Unless `synchronized`, the attach's sync runs against whatever the suite set up and its frames are the suite's
        to read, as the first sync of a v7 socket was.
        """
        if not synchronized:
            result = await self.result("chat.attach", {"team_id": self.team_id, "locale": locale})
            if result["status"] != 200:
                raise AssertionError(f"attach failed: {result!r}")
            return
        socket_module = importlib.import_module("chat.socket")
        empty = socket_module.SyncSnapshot(
            "integration",
            importlib.import_module("team.transport").TeamResponse(200, {"team_id": self.team_id, "status": "none"}),
        )
        with mock.patch.object(socket_module, "_sync_snapshot", return_value=empty):
            result = await self.result("chat.attach", {"team_id": self.team_id, "locale": locale})
            if result["status"] != 200:
                raise AssertionError(f"attach failed: {result!r}")
            if await self.next_json() != {"type": "sync-empty"}:
                raise AssertionError("attach did not synchronize the channel")

    async def disconnect(self) -> None:
        await self._incoming.put({"type": "websocket.disconnect", "code": 1000})
        await self.finish()

    async def finish(self) -> None:
        if self._task is not None:
            await asyncio.wait_for(self._task, timeout=EXPECTED_FRAME_SECONDS)


async def wait_for_thread(event: threading.Event, wait_seconds: float = EXPECTED_FRAME_SECONDS) -> None:
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not event.is_set():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("worker did not start")
        await asyncio.sleep(0.005)


def completed_turn(reply: str) -> object:
    """Return the Team's public completed-turn response for the Marketing Team."""
    local_module = importlib.import_module("chat.local")
    return local_module.PublicResponse(
        200,
        {"team_id": "team_1", "team_name": "Marketing", "reply": reply, "clarification": None},
    )


def held_turn() -> tuple[Callable[..., object], threading.Event, threading.Event]:
    """A Team turn that reports its start, then completes only once released (or after five seconds)."""
    started = threading.Event()
    release = threading.Event()

    def turn(*_args, **_kwargs):
        started.set()
        release.wait(5)
        return completed_turn("late")

    return turn, started, release


def done_frame(reply: str) -> dict[str, object]:
    """The fresh browser terminal frame for the Marketing Team's completed turn."""
    return {"type": "done", "team_id": "team_1", "team_name": "Marketing", "reply": reply, "clarification": None}


def integration_requirements() -> list[dict[str, object]]:
    return [
        {
            "assistant_id": "social-publisher",
            "assistant_name": "Social Publisher",
            "integration_id": "x-integration",
            "provider": "x",
            "name": "X integration",
            "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
            "actions": [{"id": "profile-me"}, {"id": "create-post"}],
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
    plain: dict[str, object] = {
        "kind": kind,
        "ordinal": 0,
        "title": "Confirm this Action",
        "description": "The Action is waiting for your response.",
    }
    if kind == "input:password":
        plain.update(
            label="API secret",
            required=True,
            placeholder="Enter the secret",
            min_length=1,
            max_length=1024,
            stored_input="exa-api-key",
        )
    request, rendered = localized_request.localize(plain)
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
            **localized_request.localization(rendered),
        },
    )


def live_team(case, name: str = "Team") -> None:
    """History admission confirms the Team is live under the lifecycle lock; these sockets chat with a live Team."""
    from history import delivery

    patch = mock.patch.object(delivery.team, "resolve_team_name", return_value=name)
    patch.start()
    case.addCleanup(patch.stop)


def fresh_runs(case) -> None:
    """No Team's chat run outlives one test, and each test's Space runs at most two chat operations at once."""
    gate = importlib.import_module("chat.gate")
    runs = importlib.import_module("chat.run").RUNS
    fresh = gate.Gate()
    fresh.set_limit(2)
    patcher = mock.patch.object(gate, "GATE", fresh)
    patcher.start()
    case.addCleanup(patcher.stop)
    runs.clear()
    case.addCleanup(runs.clear)
