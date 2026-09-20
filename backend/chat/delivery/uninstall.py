"""Deterministic delivery for one admitted Assistant uninstall discovery turn."""

from __future__ import annotations

from chat.connection import Connection, Turn
from chat.delivery import terminal as terminal_delivery
from chat.projection import error_terminal
from fastapi import WebSocket

from chat import assistant_proposal, lifecycle


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
    candidate: assistant_proposal.UninstallCandidate,
) -> None:
    """Deliver one already-resolved uninstall target without another discovery lane."""
    event = _matched_event(connection, turn, team_id, candidate)
    await terminal_delivery.turn(websocket, connection, turn, event)
