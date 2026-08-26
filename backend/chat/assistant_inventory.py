"""Strict Team-owned Assistant inventory projections for chat lifecycle decisions."""

from __future__ import annotations

import re
from dataclasses import dataclass

from team import bridge as team

from chat import assistant_proposal
from protocol.http.v1 import websocket as chat_ws_common

MAX_ASSISTANTS = 128
SEMANTIC_VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_RUNTIME_STATUS = re.compile(r"^[a-z]{2,24}$")


@dataclass(frozen=True, slots=True)
class InstalledAssistant:
    assistant_id: str
    version: str
    status: str


def _payload(response: object, field: str) -> object:
    if (
        not isinstance(response, team.TeamResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
    ):
        raise ValueError("Team Assistant inventory is unavailable")
    allowed = {field}
    if "trace_id" in response.body:
        trace_id = response.body["trace_id"]
        if not isinstance(trace_id, str) or chat_ws_common.HEX_ID_RE.fullmatch(trace_id) is None:
            raise ValueError("Team trace identifier is invalid")
        allowed.add("trace_id")
    if set(response.body) != allowed:
        raise ValueError("Team Assistant inventory fields are invalid")
    return response.body[field]


def installed(response: object) -> dict[str, InstalledAssistant]:
    raw = _payload(response, "assistants")
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("installed Assistant inventory is invalid")
    result: dict[str, InstalledAssistant] = {}
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"assistant", "assistant_version", "status"}:
            raise ValueError("installed Assistant fields are invalid")
        assistant_id = team.canonical_assistant_id(item["assistant"])
        version = item["assistant_version"]
        status = item["status"]
        if (
            assistant_id != item["assistant"]
            or not isinstance(version, str)
            or SEMANTIC_VERSION.fullmatch(version) is None
            or not isinstance(status, str)
            or _RUNTIME_STATUS.fullmatch(status) is None
            or assistant_id in result
        ):
            raise ValueError("installed Assistant identity is invalid")
        result[assistant_id] = InstalledAssistant(assistant_id, version, status)
    return result


def _text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("Assistant catalog text is invalid")
    return value


def registry(response: object) -> dict[str, assistant_proposal.Capability]:
    raw = _payload(response, "assistants")
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("Assistant catalog is invalid")
    capabilities: dict[str, assistant_proposal.Capability] = {}
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"id", "title", "summary", "actions"}:
            raise ValueError("Assistant catalog fields are invalid")
        assistant_id = team.canonical_assistant_id(item["id"])
        actions = item["actions"]
        if (
            assistant_id != item["id"]
            or not isinstance(actions, list)
            or not 1 <= len(actions) <= 64
            or any(not isinstance(action, str) or team.canonical_assistant_id(action) != action for action in actions)
            or len(set(actions)) != len(actions)
            or assistant_id in capabilities
        ):
            raise ValueError("Assistant catalog identity is invalid")
        capabilities[assistant_id] = assistant_proposal.Capability(
            assistant_id=assistant_id,
            name=_text(item["title"], 80),
            summary=_text(item["summary"], 160),
            actions=tuple(actions),
        )
    return capabilities
