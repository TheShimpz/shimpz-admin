"""The Admin session socket protocol `shimpz.admin.v1` (ADR-0114): closed frames, bounds, methods, and topics.

Admin owns this protocol and is its only server; this module is both the reference validator and the one Admin uses.
Every frame is one UTF-8 JSON object with unique keys in a text frame. A client frame is at most 128 KiB; a server
frame, envelope included, at most 1 MiB. The browser's copies of these bounds are pinned to this module by a static
parity test, and the browser's unit tests replay `vectors.json`.
"""

from __future__ import annotations

import json
import re

from protocol.http.v1 import identifiers

SUBPROTOCOL = "shimpz.admin.v1"
PATH = "/api/session/ws"
MAX_INBOUND_BYTES = 128 * 1024
MAX_OUTBOUND_BYTES = 1024 * 1024
MAX_QUEUED_BYTES = 1024 * 1024
MAX_IN_FLIGHT = 16
MAX_SUBSCRIPTIONS = 64
MAX_ATTACHED_TEAMS = 4
MAX_SOCKETS_PER_SESSION = 8
MAX_REVISION = 2**53 - 1

CALL_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
EPOCH_RE = re.compile(r"[0-9a-f]{32}\Z")
TOPIC_RE = re.compile(
    r"(?:teams|space/resources|platform/release|security/summary|session"
    r"|team/[a-z0-9_]{1,40}/(?:routines|history))\Z"
)
# The Team's own topics a client may name; every other topic is the Space's or the session's.
TEAM_TOPICS = ("routines", "history")
MAX_PARAM_CHARS = 128

# Each method names one Admin operation and the exact parameters it takes: required, then optional.
METHODS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "teams.list": (frozenset(), frozenset()),
    "history.page": (frozenset({"team_id"}), frozenset({"before", "routine"})),
    "routines.list": (frozenset({"team_id"}), frozenset()),
    "space.resources": (frozenset(), frozenset()),
    "platform.release": (frozenset(), frozenset()),
    "security.summary": (frozenset(), frozenset()),
    "subscribe": (frozenset({"topics"}), frozenset()),
    "unsubscribe": (frozenset({"topics"}), frozenset()),
    "chat.attach": (frozenset({"team_id", "locale"}), frozenset()),
    "chat.detach": (frozenset({"team_id"}), frozenset()),
}
# The read a topic's change asks the client to repeat; its result carries the topic revision it reflects.
READ_TOPICS = {
    "teams.list": lambda _params: "teams",
    "history.page": lambda params: f"team/{params['team_id']}/history",
    "routines.list": lambda params: f"team/{params['team_id']}/routines",
    "space.resources": lambda _params: "space/resources",
    "platform.release": lambda _params: "platform/release",
    "security.summary": lambda _params: "security/summary",
}
# Calls that change what the socket holds count against the session's change budget.
CHANGE_METHODS = frozenset({"subscribe", "unsubscribe", "chat.attach", "chat.detach"})

# The `shimpz.chat.v7` frames a client sends on an attached Team's chat channel, each carrying that Team's `team_id`.
CHAT_TYPES = frozenset({"chat", "resume-task", "stop", "sync", "human-response"})
# A person's own chat frames: Supervisor activity, which restarts the session's idle time. `sync` is the page's own.
CHAT_USER_TYPES = frozenset({"chat", "resume-task", "stop", "human-response"})


class ProtocolError(ValueError):
    """A client frame outside this protocol; it closes the socket with `close_code`."""

    def __init__(self, detail: str, close_code: int = 1008) -> None:
        super().__init__(detail)
        self.close_code = close_code


def is_call_id(value: object) -> bool:
    return isinstance(value, str) and CALL_ID_RE.fullmatch(value) is not None


def is_topic(value: object) -> bool:
    return isinstance(value, str) and TOPIC_RE.fullmatch(value) is not None


def is_team_id(value: object) -> bool:
    return identifiers.canonical_team_id(value) is not None


def _param(value: object) -> bool:
    return isinstance(value, str) and len(value) <= MAX_PARAM_CHARS


def topics(params: dict[str, object]) -> tuple[str, ...]:
    """The exact unique topics a subscription change names: one to 64."""
    value = params.get("topics")
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= MAX_SUBSCRIPTIONS
        or len(set(value)) != len(value)
        or not all(is_topic(item) for item in value)
    ):
        raise ProtocolError("invalid session topics")
    return tuple(value)


def call(frame: dict[str, object]) -> tuple[str, str, dict[str, object], bool]:
    """Admit one call frame as its id, method, params, and whether it is an automatic read."""
    keys = set(frame)
    if keys not in ({"type", "id", "method", "params"}, {"type", "id", "method", "params", "background"}):
        raise ProtocolError("invalid call frame")
    call_id, method, params = frame["id"], frame["method"], frame["params"]
    background = frame.get("background", False)
    if not is_call_id(call_id) or not isinstance(params, dict) or not isinstance(background, bool):
        raise ProtocolError("invalid call frame")
    shape = METHODS.get(method) if isinstance(method, str) else None
    if shape is None:
        raise ProtocolError("unknown session method")
    required, optional = shape
    if not required <= set(params) <= required | optional:
        raise ProtocolError("invalid call parameters")
    if method in {"subscribe", "unsubscribe"}:
        topics(params)
    elif not all(_param(value) for value in params.values()):
        raise ProtocolError("invalid call parameters")
    return call_id, method, params, background


def chat_frame(frame: dict[str, object]) -> tuple[str, dict[str, object]]:
    """Split one chat-channel frame into its Team and the `shimpz.chat.v7` frame it carries."""
    team_id = frame.get("team_id")
    if frame.get("type") not in CHAT_TYPES or not is_team_id(team_id):
        raise ProtocolError("invalid chat channel frame")
    return team_id, {key: value for key, value in frame.items() if key != "team_id"}


def encode(frame: dict[str, object]) -> str:
    """Serialize one server frame; one that exceeds the outbound bound is refused."""
    text = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > MAX_OUTBOUND_BYTES:
        raise ValueError("session socket frame exceeds its bound")
    return text


def result(call_id: str, status: int, body: object, revision: tuple[str, str, int] | None = None) -> dict[str, object]:
    frame: dict[str, object] = {"type": "result", "id": call_id, "status": status, "body": body}
    if revision is not None:
        topic, epoch, number = revision
        frame.update(topic=topic, epoch=epoch, revision=number)
    return frame


def changed(topic: str, epoch: str, revision: int) -> dict[str, object]:
    return {"type": "changed", "topic": topic, "epoch": epoch, "revision": revision}


def chat_event(team_id: str, event: dict[str, object]) -> dict[str, object]:
    """One `shimpz.chat.v7` server frame on a Team's channel: every frame carries that Team's `team_id`."""
    if event.get("team_id", team_id) != team_id:
        raise ValueError("chat frame names another Team")
    return {**event, "team_id": team_id}
