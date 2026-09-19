"""Persistence-before-projection for terminal Admin chat events."""

from __future__ import annotations

import logging
from collections.abc import Mapping

from chat.connection import Connection, Turn
from chat.projection import error_terminal
from fastapi import WebSocket, WebSocketDisconnect
from history import delivery as history_delivery
from history import store as history

log = logging.getLogger("shimpz-admin")


async def _send(websocket: WebSocket, event: Mapping[str, object]) -> bool:
    try:
        await websocket.send_json(dict(event))
    except WebSocketDisconnect, RuntimeError, OSError:
        return False
    return True


async def turn(
    websocket: WebSocket,
    connection: Connection,
    active: Turn,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or active.terminal_sent:
        return False
    projected = event
    try:
        await history_delivery.terminal(event.get("team_id"), active.history_id, event)
    except (history.HistoryUnavailableError, ValueError):
        log.exception("Admin chat reply history commit failed")
        projected = error_terminal(503, "Admin chat history is unavailable")
    active.terminal_sent = True
    if not await _send(websocket, projected):
        connection.closed = True
        return False
    return True


async def resumed(
    websocket: WebSocket,
    connection: Connection,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or connection.sync_terminal_sent:
        return False
    projected = event
    try:
        await history_delivery.resumed_terminal(event)
    except (history.HistoryUnavailableError, ValueError):
        log.exception("Admin resumed chat reply history commit failed")
        projected = error_terminal(503, "Admin chat history is unavailable")
    connection.sync_terminal_sent = True
    if not await _send(websocket, projected):
        connection.closed = True
        return False
    return True
