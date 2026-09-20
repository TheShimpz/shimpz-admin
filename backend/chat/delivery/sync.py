"""Restore one durable Team chat continuation onto an Admin socket."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from chat.connection import Connection, forget_challenge, remember_challenge
from chat.projection import (
    error_terminal,
    first_challenge,
    human_challenge_event,
    integration_challenge_event,
    turn_terminal,
)
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history
from team import bridge as team

SendEvent = Callable[[WebSocket, Connection, Mapping[str, object]], Awaitable[bool]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


class SendTerminal(Protocol):
    async def __call__(
        self,
        websocket: WebSocket,
        connection: Connection,
        event: Mapping[str, object],
        *,
        finish_history: bool = False,
    ) -> bool: ...


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    send_terminal: SendTerminal
    error_terminal: ErrorTerminal


def is_empty_pending(response: object, team_id: str) -> bool:
    return (
        isinstance(response, team.TeamResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and response.body == {"team_id": team_id, "status": "none"}
    )


def pending_error(response: object, team_id: str, challenge_type: str) -> dict[str, object]:
    if (
        isinstance(response, team.TeamResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and not 200 <= response.status < 300
    ):
        return turn_terminal(response, team_id)
    return error_terminal(502, f"the Assistant {challenge_type} challenge was invalid")


async def _restore_history(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    operations: Operations,
) -> bool:
    try:
        connection.pending_history_id = await history_delivery.resume_exact(
            team_id,
            connection.pending_history_id,
        )
    except history.HistoryUnavailableError, ValueError:
        await operations.send_terminal(
            websocket,
            connection,
            operations.error_terminal(503, "Admin chat history is unavailable"),
        )
        return False
    return True


async def empty(
    websocket: WebSocket,
    connection: Connection,
    operations: Operations,
) -> None:
    try:
        await history_delivery.abandon(connection.pending_history_id)
    except history.HistoryUnavailableError, ValueError:
        await operations.send_terminal(
            websocket,
            connection,
            operations.error_terminal(503, "Admin chat history is unavailable"),
        )
        return
    connection.pending_history_id = None
    forget_challenge(connection)
    await operations.send_event(websocket, connection, {"type": "sync-empty"})


async def integration_terminal(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    pending: dict[str, object],
    response: object,
    operations: Operations,
) -> None:
    invalid_challenge = isinstance(response, team.TeamResponse) and (
        response.status == 428
        or (
            isinstance(response.body, dict)
            and response.body.get("status") in {"human-required", "integrations-required"}
        )
    )
    if invalid_challenge:
        forget_challenge(connection)
        await operations.send_terminal(
            websocket,
            connection,
            operations.error_terminal(502, "the Assistant integration challenge was invalid"),
        )
        return
    if not await _restore_history(websocket, connection, team_id, operations):
        return
    event = turn_terminal(response, team_id)
    if event.get("type") == "done":
        forget_challenge(connection)
        await operations.send_terminal(
            websocket,
            connection,
            event,
            finish_history=True,
        )
        return
    remember_challenge(connection, pending, "integration")
    await operations.send_terminal(websocket, connection, event)


async def integration(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    pending_response: object,
    resumed_response: object,
    operations: Operations,
) -> None:
    """Deliver one explicit integration synchronization result."""
    pending = integration_challenge_event(pending_response, team_id)
    if pending is None:
        if is_empty_pending(pending_response, team_id):
            await empty(websocket, connection, operations)
            return
        await operations.send_terminal(
            websocket,
            connection,
            pending_error(pending_response, team_id, "integration"),
        )
        return
    if resumed_response is None:
        await operations.send_terminal(
            websocket,
            connection,
            operations.error_terminal(502, "the Assistant integration challenge was invalid"),
        )
        return

    resumed, challenge_type = first_challenge(resumed_response, team_id)
    if resumed is not None and challenge_type is not None:
        pending_turn_id = pending_response.body.get("turn_id")
        resumed_turn_id = resumed_response.body.get("turn_id")
        if pending_turn_id != resumed_turn_id:
            await operations.send_terminal(
                websocket,
                connection,
                operations.error_terminal(502, "the Assistant integration challenge was invalid"),
            )
            return
        if not await _restore_history(websocket, connection, team_id, operations):
            return
        remember_challenge(connection, resumed, challenge_type)
        await operations.send_event(websocket, connection, resumed)
        return

    await integration_terminal(
        websocket,
        connection,
        team_id,
        pending,
        resumed_response,
        operations,
    )


async def human(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    pending_response: object,
    operations: Operations,
) -> None:
    pending = human_challenge_event(pending_response, team_id)
    if pending is not None:
        if not await _restore_history(websocket, connection, team_id, operations):
            return
        remember_challenge(connection, pending, "human")
        await operations.send_event(websocket, connection, pending)
        return
    if is_empty_pending(pending_response, team_id):
        await empty(websocket, connection, operations)
        return
    await operations.send_terminal(
        websocket,
        connection,
        pending_error(pending_response, team_id, "human"),
    )
