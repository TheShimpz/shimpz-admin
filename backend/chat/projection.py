"""Exact public event projections for the Admin chat socket."""

from __future__ import annotations

from chat import local
from protocol.http.v1 import websocket as chat_ws_common

MAX_PUBLIC_ERROR_CHARS = 800


def error_terminal(status: object, detail: str = "local chat request failed") -> dict[str, object]:
    return chat_ws_common.error_terminal(
        status,
        detail,
        fallback_detail="local chat request failed",
        max_detail_chars=MAX_PUBLIC_ERROR_CHARS,
    )


def projected_event(
    response: object,
    team_id: str,
    allowed_types: frozenset[str],
) -> dict[str, object] | None:
    if not isinstance(response, local.PublicResponse):
        return None
    event = response.websocket_event(team_id)
    if event is None or event.get("type") not in allowed_types:
        return None
    return dict(event)


def turn_terminal(response: object, team_id: str) -> dict[str, object]:
    event = projected_event(response, team_id, frozenset({"done", "error"}))
    return event if event is not None else error_terminal(502, "local chat returned an invalid response")


def integration_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return projected_event(response, team_id, frozenset({"integrations-required"}))


def human_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return projected_event(response, team_id, frozenset({"human-required"}))


def first_challenge(response: object, team_id: str) -> tuple[dict[str, object] | None, str | None]:
    challenge = integration_challenge_event(response, team_id)
    if challenge is not None:
        return challenge, "integration"
    challenge = human_challenge_event(response, team_id)
    return (challenge, "human") if challenge is not None else (None, None)


def stop_accepted(response: object, team_id: str) -> bool | None:
    if not isinstance(response, local.PublicResponse) or not 200 <= response.status < 300:
        return None
    if response.body.get("team_id") != team_id:
        return None
    stopped = response.body.get("stopped")
    return stopped if isinstance(stopped, bool) else None
