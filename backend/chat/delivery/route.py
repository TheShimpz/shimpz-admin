"""Delivery for one structured Assistant intent preparation turn."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import Connection, Turn
from chat.delivery import plan as plan_delivery
from chat.delivery import uninstall as uninstall_delivery
from fastapi import WebSocket
from team import bridge as team

from chat import assistant_route

FinishTurn = Callable[[WebSocket, Connection, Turn, Mapping[str, object]], Awaitable[None]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


@dataclass(frozen=True, slots=True)
class Operations:
    plan: plan_delivery.Operations
    finish_turn: FinishTurn
    error_terminal: ErrorTerminal


async def _result(turn: Turn) -> assistant_route.Result:
    if turn.future is None:
        raise assistant_route.RouteError(503)
    try:
        result = await asyncio.wrap_future(turn.future)
    except asyncio.CancelledError:
        raise
    except assistant_route.RouteError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError) as exc:
        raise assistant_route.RouteError(503) from exc
    if not isinstance(result, assistant_route.Result):
        raise assistant_route.RouteError(503)
    return result


async def deliver(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    operations: Operations,
    *,
    fallback_payload: dict[str, object] | None = None,
) -> None:
    """Deliver the closed route result; failure never falls through to ordinary Brain."""
    try:
        try:
            result = await _result(turn)
        except assistant_route.RouteError as exc:
            await operations.finish_turn(
                websocket,
                connection,
                turn,
                operations.error_terminal(exc.status, "Assistant routing is unavailable; retry the message"),
            )
            return
        if connection.closed:
            return
        if turn.stop_requested:
            await operations.finish_turn(websocket, connection, turn, {"type": "stopped"})
            return
        if result.error_status is not None or result.intent == "unresolved":
            connection.ignore_idle_stop_once = True
            await operations.finish_turn(
                websocket,
                connection,
                turn,
                operations.error_terminal(result.error_status or 422, "Assistant request could not be resolved"),
            )
            return
        if result.intent == "assistant-uninstall":
            if result.uninstall is None:
                connection.ignore_idle_stop_once = True
            await uninstall_delivery.deliver_candidate(
                websocket,
                connection,
                turn,
                team_id,
                result.uninstall,
            )
            return
        if result.preparation is None:
            raise assistant_route.RouteError(503)
        if (
            fallback_payload is not None
            and result.preparation.plan is None
            and result.preparation.already_installed is None
            and result.preparation.error_status is None
        ):
            await operations.plan.continue_turn(
                websocket,
                connection,
                turn,
                team_id,
                fallback_payload,
            )
            return
        await plan_delivery.deliver_result(
            websocket,
            connection,
            turn,
            team_id,
            payload,
            result.preparation,
            operations.plan,
        )
    except assistant_route.RouteError as exc:
        if not connection.closed and not turn.terminal_sent:
            await operations.finish_turn(
                websocket,
                connection,
                turn,
                operations.error_terminal(exc.status, "Assistant routing is unavailable; retry the message"),
            )
    finally:
        if connection.active is turn and turn.operation == "assistant-route":
            connection.active = None
