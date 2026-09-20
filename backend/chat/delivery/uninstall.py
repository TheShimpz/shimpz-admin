"""Deterministic delivery for one admitted Assistant uninstall discovery turn."""

from __future__ import annotations

import logging

from chat.connection import Connection, Turn
from chat.delivery import terminal as terminal_delivery
from chat.projection import error_terminal
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history

from chat import assistant_proposal, lifecycle

log = logging.getLogger("shimpz-admin")


async def _target_required_event(team_id: str, turn: Turn) -> dict[str, object]:
    try:
        await history_delivery.guidance(
            team_id,
            turn.history_id,
            "uninstall-target-required",
        )
    except history.HistoryUnavailableError, ValueError:
        log.exception("Admin chat guidance history commit failed")
        return error_terminal(503, "Admin chat history is unavailable")
    return lifecycle.target_required_event(team_id)


def _matched_event(
    connection: Connection,
    turn: Turn,
    team_id: str,
    candidate: assistant_proposal.UninstallCandidate,
) -> dict[str, object]:
    try:
        proposal, event = lifecycle.create_proposal(
            team_id,
            candidate,
            turn.language_exemplar,
        )
    except ValueError:
        return error_terminal(503, "Assistant inventory is unavailable")
    connection.lifecycle_proposal = proposal
    lifecycle.retain_history(connection, turn.history_id, event)
    return event


async def deliver_candidate(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    candidate: assistant_proposal.UninstallCandidate | None,
) -> None:
    """Deliver one already-resolved uninstall target without another discovery lane."""
    event = (
        await _target_required_event(team_id, turn)
        if candidate is None
        else _matched_event(connection, turn, team_id, candidate)
    )
    await terminal_delivery.turn(websocket, connection, turn, event)
