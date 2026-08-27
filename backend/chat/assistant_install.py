"""Strict Team projection for one exact automatic Assistant installation."""

from __future__ import annotations

from dataclasses import dataclass

from team import bridge as team

from chat import store_catalog
from protocol.http.v1 import websocket as chat_ws_common


@dataclass(frozen=True, slots=True)
class InstallResult:
    status: int
    installed: bool | None = None


def install_publication(team_id: str, assistant: store_catalog.CatalogAssistant) -> InstallResult:
    """Submit one exact public Store selection to Team's verifying lifecycle."""
    response = team.install_assistant(
        team_id,
        {
            "assistant_id": assistant.assistant_id,
            "source_digest": assistant.source_digest,
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
        installed = _install_body(response, assistant.assistant_id)
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
