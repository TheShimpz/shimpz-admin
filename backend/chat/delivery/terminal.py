"""Persistence-before-projection for terminal Admin chat events."""

import logging
from collections.abc import Mapping

from chat.connection import Connection, Turn
from chat.delivery.progress import take_receipt
from chat.projection import error_terminal
from fastapi import WebSocket, WebSocketDisconnect
from history import delivery as history_delivery

log = logging.getLogger("shimpz-admin")


async def send(websocket: WebSocket, event: Mapping[str, object]) -> bool:
    """Send one event, reporting a closed or failed socket as False."""
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
    *,
    finish_history: bool = False,
) -> bool:
    if connection.closed or active.terminal_sent:
        return False
    projected = event
    # Every terminal ends the turn's receipt, as it does on the page; a reply keeps the steps its page was shown.
    receipt = take_receipt(connection.receipt, active.history_id)
    # A Stop of a paused turn that failed leaves that turn waiting: nothing of it ended, so nothing is kept.
    unended = active.operation == "pending-stop" and event.get("type") == "error"
    try:
        if not unended:
            await history_delivery.terminal(
                connection.team_id,
                active.history_id,
                event,
                finish_history=finish_history,
                receipt=receipt,
            )
    except Exception:
        # Whatever stops the commit, the turn still ends with a terminal the browser sees, never a silence.
        log.exception("Admin chat reply history commit failed")
        projected = error_terminal(503, "Admin chat history is unavailable")
    else:
        if (event.get("type") == "done" or finish_history) and active.history_id == connection.pending_history_id:
            connection.pending_history_id = None
    active.terminal_sent = True
    if not await send(websocket, projected):
        connection.closed = True
        return False
    return True


async def resumed(
    websocket: WebSocket,
    connection: Connection,
    event: Mapping[str, object],
    *,
    finish_history: bool = False,
) -> bool:
    if connection.closed or connection.sync_terminal_sent:
        return False
    projected = event
    receipt = take_receipt(connection.receipt, connection.pending_history_id)
    if finish_history:
        try:
            await history_delivery.resumed_terminal(
                connection.team_id, connection.pending_history_id, event, receipt=receipt
            )
        except Exception:
            log.exception("Admin resumed chat reply history commit failed")
            projected = error_terminal(503, "Admin chat history is unavailable")
        else:
            connection.pending_history_id = None
    connection.sync_terminal_sent = True
    if not await send(websocket, projected):
        connection.closed = True
        return False
    return True
