"""Strict Team projection for one exact automatic Assistant installation."""

from collections.abc import Callable
from dataclasses import dataclass

from team import bridge as team

from chat import local_catalog, store_catalog

# Team's closed refusal of a fresh install beyond the Team's MAX_TEAM_ASSISTANTS; Admin localizes it.
ASSISTANT_LIMIT_REACHED = "assistant_limit_reached"


@dataclass(frozen=True, slots=True)
class InstallResult:
    status: int
    installed: bool | None = None
    code: str | None = None


def limit_code(status: int, body: object) -> str | None:
    """Carry only Team's closed Assistant-limit refusal; any other failure stays a bare status."""
    if status == 409 and isinstance(body, dict) and body.get("code") == ASSISTANT_LIMIT_REACHED:
        return ASSISTANT_LIMIT_REACHED
    return None


def install_publication(team_id: str, assistant: store_catalog.CatalogAssistant) -> InstallResult:
    """Submit one exact public Store selection to Team's verifying lifecycle."""
    response = team.install_assistant(
        team_id,
        {
            "assistant_id": assistant.assistant_id,
            "source_digest": assistant.source_digest,
        },
    )
    return _result(response, lambda admitted: _install_body(admitted, assistant.assistant_id))


def install_local_snapshot(team_id: str, assistant: local_catalog.LocalAssistant) -> InstallResult:
    """Submit one exact staged image to Team's fresh-only Local lifecycle."""
    response = team.install_fresh_local_assistant(team_id, {"image_id": assistant.image_id})
    return _result(response, lambda admitted: _local_install_body(admitted, assistant))


def _result(response: object, installed: Callable[[team.TeamResponse], bool]) -> InstallResult:
    if not team.is_team_response(response):
        return InstallResult(502)
    if not 200 <= response.status < 300:
        return InstallResult(response.status, code=limit_code(response.status, response.body))
    try:
        return InstallResult(response.status, installed(response))
    except ValueError:
        return InstallResult(502)


def _install_body(response: team.TeamResponse, assistant_id: str) -> bool:
    if not isinstance(response.body, dict):
        raise ValueError("Assistant install result is invalid")
    allowed = team.trace_envelope(response.body, {"assistant", "installed"})
    installed = response.body.get("installed")
    if (
        set(response.body) != allowed
        or response.body.get("assistant") != assistant_id
        or not isinstance(installed, bool)
    ):
        raise ValueError("Assistant install result is invalid")
    return installed


def _local_install_body(response: team.TeamResponse, assistant: local_catalog.LocalAssistant) -> bool:
    if not isinstance(response.body, dict):
        raise ValueError("Local Assistant install result is invalid")
    allowed = team.trace_envelope(response.body, {"assistant", "installed", "provenance", "image_id", "unpublished"})
    installed = response.body.get("installed")
    if (
        set(response.body) != allowed
        or response.body.get("assistant") != assistant.assistant_id
        or response.body.get("image_id") != assistant.image_id
        or response.body.get("provenance") != "local"
        or response.body.get("unpublished") is not True
        or not isinstance(installed, bool)
    ):
        raise ValueError("Local Assistant install result is invalid")
    return installed
