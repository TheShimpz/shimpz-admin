"""Strict Team-owned Assistant inventory projections for chat lifecycle decisions."""

import re
from dataclasses import dataclass

from team import bridge as team
from team import transport

from chat import assistant_proposal, payloads, store_catalog
from protocol.http.v1 import payload as team_contract

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


def _assistants(response: object) -> object:
    if (
        not transport.is_team_response(response)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
    ):
        raise ValueError("Team Assistant inventory is unavailable")
    if set(response.body) != transport.trace_envelope(response.body, {"assistants"}):
        raise ValueError("Team Assistant inventory fields are invalid")
    return response.body["assistants"]


def installed(response: object) -> dict[str, InstalledAssistant]:
    raw = _assistants(response)
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
        assistant_id = payloads.canonical_assistant_id(item["assistant"])
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


def binding_creator(team_id: str, assistant_id: str, version: str) -> str:
    """The first Creator the exact binding a Team runs declares, as its chat card shows it beside the version.

    Team answers for the binding it runs, so the identity and version it returns must be the installed ones; anything
    else, or a Team failure, is refused.
    """
    response = team.assistant_details(team_id, assistant_id, store_catalog.PLANNING_LOCALE)
    if not transport.is_team_response(response) or response.status != 200 or not isinstance(response.body, dict):
        raise ValueError("installed Assistant details are unavailable")
    details = team_contract.canonical_assistant_details(
        {key: value for key, value in response.body.items() if key != "trace_id"}
    )
    if (
        details is None
        or details["locale"] != store_catalog.PLANNING_LOCALE
        or details["assistant_id"] != assistant_id
        or details["assistant_version"] != version
    ):
        raise ValueError("installed Assistant details are invalid")
    return details["creators"][0]


def names(response: object) -> dict[str, str]:
    """The Space's admissible Assistants by name: each identity once, with its catalog name."""
    raw = _assistants(response)
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("Assistant names are invalid")
    named: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"id", "title"}:
            raise ValueError("Assistant name fields are invalid")
        assistant_id = payloads.canonical_assistant_id(item["id"])
        if assistant_id != item["id"] or assistant_id in named:
            raise ValueError("Assistant name identity is invalid")
        named[assistant_id] = store_catalog.catalog_text(item["title"], 80)
    return named


def registry(response: object) -> dict[str, assistant_proposal.Capability]:
    """One Team's admitted Assistants with the capabilities its own bindings declare."""
    raw = _assistants(response)
    if not isinstance(raw, list) or len(raw) > team_contract.MAX_TEAM_ASSISTANTS:
        raise ValueError("Assistant catalog is invalid")
    capabilities: dict[str, assistant_proposal.Capability] = {}
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"id", "title", "summary", "actions"}:
            raise ValueError("Assistant catalog fields are invalid")
        assistant_id = payloads.canonical_assistant_id(item["id"])
        actions = item["actions"]
        if (
            assistant_id != item["id"]
            or not isinstance(actions, list)
            or not 1 <= len(actions) <= MAX_ACTIONS_PER_ASSISTANT
            or any(not isinstance(action, str) or payloads.canonical_action_id(action) != action for action in actions)
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
