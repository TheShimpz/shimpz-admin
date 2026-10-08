"""Strict Team-owned Assistant inventory projections for chat lifecycle decisions."""

from __future__ import annotations

import re
from dataclasses import dataclass

from team import bridge as team

from chat import assistant_proposal, store_catalog

MAX_ASSISTANTS = 128
# Team admits the Developers install protocol's 128 Actions per Assistant.
MAX_ACTIONS_PER_ASSISTANT = 128
_RUNTIME_STATUS = re.compile(r"^[a-z]{2,24}$")
_PROVENANCES = frozenset({"local", "published"})


@dataclass(frozen=True, slots=True)
class InstalledAssistant:
    assistant_id: str
    version: str
    provenance: str
    status: str


def _payload(response: object, field: str) -> object:
    if not team.is_team_response(response) or not 200 <= response.status < 300 or not isinstance(response.body, dict):
        raise ValueError("Team Assistant inventory is unavailable")
    if set(response.body) != team.trace_envelope(response.body, {field}):
        raise ValueError("Team Assistant inventory fields are invalid")
    return response.body[field]


def installed(response: object) -> dict[str, InstalledAssistant]:
    raw = _payload(response, "assistants")
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("installed Assistant inventory is invalid")
    result: dict[str, InstalledAssistant] = {}
    for item in raw:
        if not isinstance(item, dict) or set(item) != {
            "assistant",
            "assistant_version",
            "provenance",
            "status",
        }:
            raise ValueError("installed Assistant fields are invalid")
        assistant_id = team.canonical_assistant_id(item["assistant"])
        version = item["assistant_version"]
        provenance = item["provenance"]
        status = item["status"]
        if (
            assistant_id != item["assistant"]
            or not isinstance(version, str)
            or store_catalog.VERSION_RE.fullmatch(version) is None
            or provenance not in _PROVENANCES
            or not isinstance(status, str)
            or _RUNTIME_STATUS.fullmatch(status) is None
            or assistant_id in result
        ):
            raise ValueError("installed Assistant identity is invalid")
        result[assistant_id] = InstalledAssistant(assistant_id, version, provenance, status)
    return result


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
            or not 1 <= len(actions) <= MAX_ACTIONS_PER_ASSISTANT
            or any(not isinstance(action, str) or team.canonical_action_id(action) != action for action in actions)
            or len(set(actions)) != len(actions)
            or assistant_id in capabilities
        ):
            raise ValueError("Assistant catalog identity is invalid")
        capabilities[assistant_id] = assistant_proposal.Capability(
            assistant_id=assistant_id,
            name=store_catalog.catalog_text(item["title"], 80),
            summary=store_catalog.catalog_text(item["summary"], 80),
            actions=tuple(actions),
        )
    return capabilities
