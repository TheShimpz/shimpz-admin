"""Strict Team projections for conversational Assistant discovery and installation."""

from __future__ import annotations

import re
from dataclasses import dataclass

from team import bridge as team

from chat import assistant_proposal, store_catalog
from protocol.http.v1 import websocket as chat_ws_common

MAX_ASSISTANTS = 128
MAX_ENABLED_ASSISTANTS = 16
_SEMANTIC_VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_RUNTIME_STATUS = re.compile(r"^[a-z]{2,24}$")


@dataclass(frozen=True, slots=True)
class InstallResult:
    status: int
    installed: bool | None = None


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


def _installed(response: object) -> frozenset[str]:
    raw = _payload(response, "assistants")
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("installed Assistant inventory is invalid")
    identities: list[str] = []
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"assistant", "assistant_version", "status"}:
            raise ValueError("installed Assistant fields are invalid")
        assistant_id = team.canonical_assistant_id(item["assistant"])
        if (
            assistant_id != item["assistant"]
            or not isinstance(item["assistant_version"], str)
            or _SEMANTIC_VERSION.fullmatch(item["assistant_version"]) is None
            or not isinstance(item["status"], str)
            or _RUNTIME_STATUS.fullmatch(item["status"]) is None
        ):
            raise ValueError("installed Assistant identity is invalid")
        identities.append(assistant_id)
    if len(set(identities)) != len(identities):
        raise ValueError("installed Assistants are duplicated")
    return frozenset(identities)


def _text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("Assistant catalog text is invalid")
    return value


def _registry(response: object) -> dict[str, assistant_proposal.Capability]:
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


def discover(
    team_id: str,
    message: str,
    enabled_ids: tuple[str, ...],
    catalog: store_catalog.StoreCatalog,
) -> store_catalog.CatalogAssistant | None:
    """Return one strong, uninstalled Store candidate from strict current Team state."""
    if len(enabled_ids) > MAX_ENABLED_ASSISTANTS or len(set(enabled_ids)) != len(enabled_ids):
        raise ValueError("enabled Assistant scope is invalid")
    installed = _installed(team.list_installed_assistants(team_id))
    registry = _registry(team.list_assistants())
    if any(assistant_id not in registry or assistant_id not in installed for assistant_id in enabled_ids):
        raise ValueError("enabled Assistant scope is not authoritative")
    enabled = tuple(registry[assistant_id] for assistant_id in enabled_ids)
    return assistant_proposal.select_candidate(
        message,
        catalog.get(),
        installed_ids=installed,
        enabled=enabled,
    )


def install(proposal: assistant_proposal.InstallProposal) -> InstallResult:
    """Submit one exact Team-owned installation intent and admit only its minimal result."""
    response = team.install_assistant(
        proposal.team_id,
        {
            "assistant_id": proposal.assistant.assistant_id,
            "source_digest": proposal.assistant.source_digest,
        },
    )
    if (
        not isinstance(response, team.TeamResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
    ):
        return InstallResult(502)
    if not 200 <= response.status < 300:
        return InstallResult(response.status)
    try:
        installed = _install_body(response, proposal.assistant.assistant_id)
    except ValueError:
        return InstallResult(502)
    return InstallResult(response.status, installed)


def _install_body(response: team.TeamResponse, assistant_id: str) -> bool:
    if not isinstance(response.body, dict):
        raise ValueError("Assistant install result is invalid")
    allowed = {"assistant", "installed"}
    if "trace_id" in response.body:
        trace_id = response.body["trace_id"]
        if not isinstance(trace_id, str) or chat_ws_common.HEX_ID_RE.fullmatch(trace_id) is None:
            raise ValueError("Team trace identifier is invalid")
        allowed.add("trace_id")
    installed = response.body.get("installed")
    if (
        set(response.body) != allowed
        or response.body.get("assistant") != assistant_id
        or not isinstance(installed, bool)
    ):
        raise ValueError("Assistant install result is invalid")
    return installed
