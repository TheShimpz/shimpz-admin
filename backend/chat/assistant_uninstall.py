"""Strict Team projections and execution for conversational Assistant uninstall."""

from __future__ import annotations

from dataclasses import dataclass

from team import bridge as team

from chat import assistant_inventory, assistant_proposal
from protocol.http.v1 import websocket as chat_ws_common


@dataclass(frozen=True, slots=True)
class UninstallResult:
    status: int
    uninstalled: bool | None = None


def discover(team_id: str, message: object) -> assistant_proposal.UninstallCandidate | None:
    """Return one explicitly named installed Assistant from strict Team-owned state."""
    if not assistant_proposal.uninstall_requested(message):
        return None
    installed = assistant_inventory.installed(team.list_installed_assistants(team_id))
    registry = assistant_inventory.registry(team.list_assistants())
    if any(assistant_id not in registry for assistant_id in installed):
        raise ValueError("installed Assistant scope is not authoritative")
    candidates = tuple(
        assistant_proposal.UninstallCandidate(registry[assistant_id], item.version)
        for assistant_id, item in installed.items()
    )
    return assistant_proposal.select_uninstall_candidate(message, candidates)


def uninstall(proposal: assistant_proposal.UninstallProposal) -> UninstallResult:
    """Revalidate the proposed version and invoke only Team's uninstall authority."""
    installed = assistant_inventory.installed(team.list_installed_assistants(proposal.team_id))
    current = installed.get(proposal.assistant.assistant_id)
    if current is None:
        result = UninstallResult(200, False)
    elif current.version != proposal.assistant_version:
        result = UninstallResult(409)
    else:
        response = team.uninstall_assistant(proposal.team_id, proposal.assistant.assistant_id)
        result = _project_result(response, proposal.assistant.assistant_id)
    return result


def _project_result(response: object, assistant_id: str) -> UninstallResult:
    if not isinstance(response, team.TeamResponse) or not isinstance(response.status, int) or isinstance(
        response.status,
        bool,
    ):
        return UninstallResult(502)
    if response.status == 404 and _is_exact_absence(response):
        return UninstallResult(200, False)
    if not 200 <= response.status < 300:
        return UninstallResult(response.status)
    try:
        uninstalled = _uninstall_body(response, assistant_id)
    except ValueError:
        return UninstallResult(502)
    return UninstallResult(response.status, uninstalled)


def _trace_id(value: object) -> bool:
    return isinstance(value, str) and chat_ws_common.HEX_ID_RE.fullmatch(value) is not None


def _is_exact_absence(response: team.TeamResponse) -> bool:
    body = response.body
    return (
        isinstance(body, dict)
        and set(body) == {"code", "error", "trace_id"}
        and body.get("code") == "assistant-not-allowlisted"
        and isinstance(body.get("error"), str)
        and 1 <= len(body["error"]) <= 500
        and _trace_id(body.get("trace_id"))
    )


def _uninstall_body(response: team.TeamResponse, assistant_id: str) -> bool:
    if not isinstance(response.body, dict):
        raise ValueError("Assistant uninstall result is invalid")
    allowed = {"assistant", "uninstalled"}
    if "trace_id" in response.body:
        if not _trace_id(response.body["trace_id"]):
            raise ValueError("Team trace identifier is invalid")
        allowed.add("trace_id")
    uninstalled = response.body.get("uninstalled")
    if (
        set(response.body) != allowed
        or response.body.get("assistant") != assistant_id
        or not isinstance(uninstalled, bool)
    ):
        raise ValueError("Assistant uninstall result is invalid")
    return uninstalled
