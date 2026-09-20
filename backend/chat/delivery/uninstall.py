"""Deterministic delivery for one admitted Assistant uninstall discovery turn."""

from __future__ import annotations

import asyncio
import logging

from chat.connection import Connection, Turn
from chat.delivery import terminal as terminal_delivery
from chat.projection import error_terminal
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history
from team import bridge as team

from chat import assistant_proposal, lifecycle

log = logging.getLogger("shimpz-admin")


def _inactive(connection: Connection, turn: Turn) -> bool:
    return connection.closed or turn.stop_requested or turn.terminal_sent


async def _target_required_event(team_id: str, turn: Turn) -> dict[str, object]:
    try:
        await history_delivery.guidance(
            team_id,
            turn.history_id,
            "uninstall-target-required",
        )
    except (history.HistoryUnavailableError, ValueError):
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


async def _candidate_event(
    connection: Connection,
    turn: Turn,
    team_id: str,
) -> dict[str, object] | None:
    if turn.future is None:
        return error_terminal(503, "Assistant inventory is unavailable")
    candidate = await asyncio.wrap_future(turn.future)
    if _inactive(connection, turn):
        return None
    if candidate is not None and not isinstance(candidate, assistant_proposal.UninstallCandidate):
        return error_terminal(503, "Assistant inventory is unavailable")
    if candidate is None:
        return await _target_required_event(team_id, turn)
    return _matched_event(connection, turn, team_id, candidate)


async def deliver(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
) -> None:
    """Resolve discovery without falling through to Brain or Team chat."""
    try:
        try:
            event = await _candidate_event(connection, turn, team_id)
        except asyncio.CancelledError:
            raise
        except OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError:
            event = error_terminal(503, "Assistant inventory is unavailable")
        if event is None or _inactive(connection, turn):
            return
        await terminal_delivery.turn(websocket, connection, turn, event)
    finally:
        if connection.active is turn:
            connection.active = None
