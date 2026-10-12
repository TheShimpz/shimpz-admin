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
    r"(?:teams|space/(?:resources|models|decision)|platform/release|security/summary|session|assistants/registry"
    r"|local-assistants"
    r"|team/[a-z0-9_]{1,40}/(?:routines|history|inventory|inference))\Z"
)
# The Team's own topics a client may name; every other topic is the Space's or the session's.
TEAM_TOPICS = ("routines", "history", "inventory", "inference")
MAX_PARAM_CHARS = 128
KIB = 1024

# Each method names one Admin operation and the exact parameters it takes: required, then optional. Every parameter is
# a string of at most 128 characters, except `topics` and a request `body`, which is one JSON object.
_TEAM = frozenset({"team_id"})
_NONE: frozenset[str] = frozenset()
METHODS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "teams.list": (_NONE, _NONE),
    "teams.create": (frozenset({"body"}), _NONE),
    "teams.rename": (frozenset({"team_id", "body"}), _NONE),
    "teams.reorder": (frozenset({"body"}), _NONE),
    "teams.delete": (frozenset({"team_id", "body"}), _NONE),
    "history.page": (_TEAM, frozenset({"before", "routine"})),
    "routines.list": (_TEAM, _NONE),
    "space.resources": (_NONE, _NONE),
    "platform.release": (_NONE, _NONE),
    "security.summary": (_NONE, _NONE),
    "inference.read": (_TEAM, _NONE),
    "inference.save": (frozenset({"team_id", "body"}), _NONE),
    "action_confirmation.read": (_TEAM, _NONE),
    "action_confirmation.save": (frozenset({"team_id", "body"}), _NONE),
    "assistants.registry": (_NONE, _NONE),
    "assistants.list": (_TEAM, _NONE),
    "assistants.install": (frozenset({"team_id", "body"}), _NONE),
    "assistants.install_local": (frozenset({"team_id", "body"}), _NONE),
    "assistants.uninstall": (frozenset({"team_id", "assistant_id"}), _NONE),
    "assistants.summary": (frozenset({"team_id", "assistant_id", "locale"}), _NONE),
    "assistants.details": (frozenset({"team_id", "assistant_id", "locale"}), _NONE),
    "snapshots.list": (_NONE, _NONE),
    "snapshots.summary": (frozenset({"image_id", "locale"}), _NONE),
    "snapshots.details": (frozenset({"image_id", "locale"}), _NONE),
    "models.list": (_NONE, _NONE),
    "models.save": (frozenset({"provider", "body"}), _NONE),
    "models.remove": (frozenset({"provider"}), _NONE),
    "decision.read": (_NONE, _NONE),
    "decision.save": (frozenset({"body"}), _NONE),
    "decision.remove": (_NONE, _NONE),
    "integrations.list": (_TEAM, _NONE),
    "integrations.authorize": (frozenset({"team_id", "challenge_id", "body"}), _NONE),
    "integrations.complete": (frozenset({"team_id", "challenge_id", "body"}), _NONE),
    "integrations.cancel": (frozenset({"team_id", "challenge_id"}), _NONE),
    "integrations.disconnect": (frozenset({"team_id", "assistant_id", "integration_id"}), _NONE),
    "stored_inputs.list": (_TEAM, _NONE),
    "stored_inputs.clear": (frozenset({"team_id", "assistant_id", "stored_input_id"}), _NONE),
    "files.list": (_TEAM, _NONE),
    "files.delete": (frozenset({"team_id", "file_id"}), _NONE),
    "store.catalog": (frozenset({"locale"}), frozenset({"cursor"})),
    "subscribe": (frozenset({"topics"}), _NONE),
    "unsubscribe": (frozenset({"topics"}), _NONE),
    "chat.attach": (frozenset({"team_id", "locale"}), _NONE),
    "chat.detach": (_TEAM, _NONE),
}
# The most bytes each method's request body takes as compact UTF-8 JSON: the bound its operation always had (a Team
# name 1 KiB, a Team order or deletion 8 KiB, every other body 16 KiB). A larger body is answered 413.
BODY_BYTES = {
    "teams.create": 1 * KIB,
    "teams.rename": 1 * KIB,
    "teams.reorder": 8 * KIB,
    "teams.delete": 8 * KIB,
    "inference.save": 16 * KIB,
    "action_confirmation.save": 16 * KIB,
    "assistants.install": 16 * KIB,
    "assistants.install_local": 16 * KIB,
    "models.save": 16 * KIB,
    "decision.save": 16 * KIB,
    "integrations.authorize": 16 * KIB,
    "integrations.complete": 16 * KIB,
}
# A long call keeps its result pending while it runs and says once, with `progress`, that it started.
LONG_METHODS = frozenset({"assistants.install", "assistants.install_local"})


def _team_topic(name: str):
    return lambda params: f"team/{params['team_id']}/{name}"


# The read a topic's change asks the client to repeat; its result carries the topic revision it reflects.
READ_TOPICS = {
    "teams.list": lambda _params: "teams",
    "history.page": _team_topic("history"),
    "routines.list": _team_topic("routines"),
    "space.resources": lambda _params: "space/resources",
    "platform.release": lambda _params: "platform/release",
    "security.summary": lambda _params: "security/summary",
    "inference.read": _team_topic("inference"),
    "action_confirmation.read": _team_topic("inference"),
    "assistants.registry": lambda _params: "assistants/registry",
    "assistants.list": _team_topic("inventory"),
    "assistants.summary": _team_topic("inventory"),
    "assistants.details": _team_topic("inventory"),
    "snapshots.list": lambda _params: "local-assistants",
    "snapshots.summary": lambda _params: "local-assistants",
    "snapshots.details": lambda _params: "local-assistants",
    "models.list": lambda _params: "space/models",
    "decision.read": lambda _params: "space/decision",
}
# Calls that change what the socket holds count against the session's change budget.
CHANGE_METHODS = frozenset({"subscribe", "unsubscribe", "chat.attach", "chat.detach"})

# The `shimpz.chat.v7` frames a client sends on an attached Team's chat channel, each carrying that Team's `team_id`.
CHAT_TYPES = frozenset({"chat", "resume-task", "stop", "sync", "human-response"})
# The content-free frame the page sends on the person's own input: the only frame that restarts the session's idle time.
ACTIVITY = {"type": "activity"}


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


def call(frame: dict[str, object]) -> tuple[str, str, dict[str, object]]:
    """Admit one call frame as its id, method, and params."""
    if set(frame) != {"type", "id", "method", "params"}:
        raise ProtocolError("invalid call frame")
    call_id, method, params = frame["id"], frame["method"], frame["params"]
    if not is_call_id(call_id) or not isinstance(params, dict):
        raise ProtocolError("invalid call frame")
    shape = METHODS.get(method) if isinstance(method, str) else None
    if shape is None:
        raise ProtocolError("unknown session method")
    required, optional = shape
    if not required <= set(params) <= required | optional:
        raise ProtocolError("invalid call parameters")
    if method in {"subscribe", "unsubscribe"}:
        topics(params)
    elif not all(isinstance(value, dict) if name == "body" else _param(value) for name, value in params.items()):
        raise ProtocolError("invalid call parameters")
    return call_id, method, params


def body_bytes(body: dict[str, object]) -> int:
    """A request body's size as the page sends it: compact JSON in UTF-8."""
    text = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return len(text.encode("utf-8", errors="surrogatepass"))


def activity(frame: dict[str, object]) -> None:
    """Admit the person's activity frame, which carries nothing else."""
    if frame != ACTIVITY:
        raise ProtocolError("invalid activity frame")


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


def progress(call_id: str) -> dict[str, object]:
    """A long call started running: its result follows when it ends, or is lost with the socket."""
    return {"type": "progress", "id": call_id, "state": "running"}


def session(idle_seconds: float, absolute_seconds: float) -> dict[str, object]:
    """The session's two deadlines, in whole seconds from now on Admin's clock: idle and absolute expiry."""
    return {"type": "session", "idle_seconds": int(idle_seconds), "absolute_seconds": int(absolute_seconds)}


def changed(topic: str, epoch: str, revision: int) -> dict[str, object]:
    return {"type": "changed", "topic": topic, "epoch": epoch, "revision": revision}


def chat_event(team_id: str, event: dict[str, object]) -> dict[str, object]:
    """One `shimpz.chat.v7` server frame on a Team's channel: every frame carries that Team's `team_id`."""
    if event.get("team_id", team_id) != team_id:
        raise ValueError("chat frame names another Team")
    return {**event, "team_id": team_id}
