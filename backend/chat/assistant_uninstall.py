"""Strict Team projections and execution for conversational Assistant uninstall."""

from dataclasses import dataclass

from team import bridge as team
from team import transport

from chat import assistant_inventory, assistant_proposal


@dataclass(frozen=True, slots=True)
class UninstallResult:
    status: int
    uninstalled: bool | None = None


@dataclass(frozen=True, slots=True)
class UninstallDirectory:
    """The installed Assistants a chat request may name, and which of them the current contract refuses."""

    candidates: tuple[assistant_proposal.UninstallCandidate, ...]
    refused: frozenset[str]


def candidates(team_id: str) -> UninstallDirectory:
    """Return the exact installed Assistant directory from strict Team-owned state.

    A binding the current contract refuses is listed `invalid` with no registry entry. It stays in the directory under
    its identity, so a request naming it selects it and is answered with guidance instead of a card for another
    Assistant; it has no card to confirm. Any other installed Assistant missing from the Team's registry means the two
    disagree, and nothing is offered.
    """
    installed = assistant_inventory.installed(team.list_installed_assistants(team_id))
    registry = assistant_inventory.registry(team.team_assistant_registry(team_id))
    refused = frozenset(
        assistant_id
        for assistant_id, item in installed.items()
        if assistant_id not in registry and item.status == "invalid"
    )
    if any(assistant_id not in registry and assistant_id not in refused for assistant_id in installed):
        raise ValueError("installed Assistant scope is not authoritative")
    unnamed = {
        assistant_id: assistant_proposal.Capability(assistant_id, assistant_id, "", ()) for assistant_id in refused
    }
    return UninstallDirectory(
        tuple(
            assistant_proposal.UninstallCandidate(
                registry.get(assistant_id) or unnamed[assistant_id], item.version, item.provenance
            )
            for assistant_id, item in sorted(installed.items())
        ),
        refused,
    )


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
    if not transport.is_team_response(response):
        return UninstallResult(502)
    if not 200 <= response.status < 300:
        return UninstallResult(response.status)
    try:
        projected = _uninstall_body(response, assistant_id)
    except ValueError:
        return UninstallResult(502)
    return UninstallResult(response.status, projected)


def _uninstall_body(response: transport.TeamResponse, assistant_id: str) -> bool:
    if not isinstance(response.body, dict):
        raise ValueError("Assistant uninstall result is invalid")
    allowed = transport.trace_envelope(response.body, {"assistant", "uninstalled"})
    uninstalled = response.body.get("uninstalled")
    if (
        set(response.body) != allowed
        or response.body.get("assistant") != assistant_id
        or not isinstance(uninstalled, bool)
    ):
        raise ValueError("Assistant uninstall result is invalid")
    return uninstalled
