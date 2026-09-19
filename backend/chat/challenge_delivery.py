"""Commit and project one Team-owned chat challenge."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import Connection, Turn, remember_challenge
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]
SendTerminal = Callable[[WebSocket, Connection, Turn, Mapping[str, object]], Awaitable[bool]]
ErrorTerminal = Callable[[object, str], dict[str, object]]

log = logging.getLogger("shimpz-admin")


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    send_terminal: SendTerminal
    error_terminal: ErrorTerminal


async def deliver(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    challenge: dict[str, object],
    challenge_type: str,
    operations: Operations,
) -> None:
    try:
        await history_delivery.challenge(team_id, turn.history_id)
    except (history.HistoryUnavailableError, ValueError):
        log.exception("Admin chat challenge history commit failed")
        await operations.send_terminal(
            websocket,
            connection,
            turn,
            operations.error_terminal(503, "Admin chat history is unavailable"),
        )
        return
    remember_challenge(connection, challenge, challenge_type)
    if not await operations.send_event(websocket, challenge):
        connection.closed = True
