"""Strict bounded planning projection for locally staged Assistant snapshots."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from team import bridge as team

from chat import store_catalog
from protocol.http.v1 import websocket as chat_ws_common

MAX_ASSISTANTS = 50
_VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_CREATOR = re.compile(r"^@[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
_CREATED = re.compile(r"^[0-9TZ:+.-]{20,64}$")
_PLATFORMS = frozenset({"linux/amd64", "linux/arm64"})
_FIELDS = frozenset(
    {
        "assistant_id",
        "assistant_version",
        "name",
        "summary",
        "declared_creators",
        "actions",
        "integrations",
        "image_id",
        "platform",
        "created_at",
        "provenance",
        "unpublished",
    }
)


@dataclass(frozen=True, slots=True)
class LocalAssistant:
    assistant_id: str
    name: str
    summary: str
    image_id: str
    integrations: tuple[store_catalog.CatalogIntegration, ...]
    actions: tuple[str, ...]
    assistant_version: str
    created_at: datetime


def _text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("Local Assistant display text is invalid")
    return value


def _ids(value: object, *, maximum: int, required: bool) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maximum or (required and not value):
        raise ValueError("Local Assistant capability projection is invalid")
    output = tuple(team.canonical_assistant_id(item) for item in value)
    if any(item is None for item in output) or output != tuple(sorted(set(output))):
        raise ValueError("Local Assistant capability projection is invalid")
    return output


def _created_at(value: object) -> datetime:
    if not isinstance(value, str) or _CREATED.fullmatch(value) is None:
        raise ValueError("Local Assistant creation time is invalid")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Local Assistant creation time is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Local Assistant creation time is invalid")
    return parsed


def _assistant(value: object) -> LocalAssistant:
    if not isinstance(value, dict) or set(value) != _FIELDS:
        raise ValueError("Local Assistant fields are invalid")
    assistant_id = team.canonical_assistant_id(value["assistant_id"])
    version = value["assistant_version"]
    image_id = value["image_id"]
    creators = value["declared_creators"]
    if (
        assistant_id != value["assistant_id"]
        or not isinstance(version, str)
        or _VERSION.fullmatch(version) is None
        or not isinstance(image_id, str)
        or _DIGEST.fullmatch(image_id) is None
        or not isinstance(creators, list)
        or not 1 <= len(creators) <= 4
        or any(not isinstance(creator, str) or _CREATOR.fullmatch(creator) is None for creator in creators)
        or len(set(creators)) != len(creators)
        or value["platform"] not in _PLATFORMS
        or value["provenance"] != "local"
        or value["unpublished"] is not True
    ):
        raise ValueError("Local Assistant identity is invalid")
    actions = _ids(value["actions"], maximum=128, required=True)
    providers = _ids(value["integrations"], maximum=16, required=False)
    return LocalAssistant(
        assistant_id=assistant_id,
        name=_text(value["name"], 80),
        summary=_text(value["summary"], 160),
        image_id=image_id,
        integrations=tuple(store_catalog.CatalogIntegration(provider, ()) for provider in providers),
        actions=actions,
        assistant_version=version,
        created_at=_created_at(value["created_at"]),
    )


def primary(response: object) -> tuple[LocalAssistant, ...]:
    """Return the newest exact staged image for every Local Assistant identity."""
    if (
        not isinstance(response, team.TeamResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
    ):
        raise ValueError("Local Assistant inventory is unavailable")
    allowed = {"assistants"}
    if "trace_id" in response.body:
        trace_id = response.body["trace_id"]
        if not isinstance(trace_id, str) or chat_ws_common.HEX_ID_RE.fullmatch(trace_id) is None:
            raise ValueError("Team trace identifier is invalid")
        allowed.add("trace_id")
    raw = response.body.get("assistants")
    if set(response.body) != allowed or not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("Local Assistant inventory is invalid")
    candidates = tuple(_assistant(item) for item in raw)
    image_ids = tuple(candidate.image_id for candidate in candidates)
    if len(set(image_ids)) != len(image_ids):
        raise ValueError("Local Assistant inventory is invalid")
    newest: dict[str, LocalAssistant] = {}
    for candidate in candidates:
        current = newest.get(candidate.assistant_id)
        if current is None or (candidate.created_at, candidate.image_id) > (current.created_at, current.image_id):
            newest[candidate.assistant_id] = candidate
    return tuple(newest[assistant_id] for assistant_id in sorted(newest))
