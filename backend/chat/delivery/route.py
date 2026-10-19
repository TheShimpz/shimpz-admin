"""Delivery for one structured Assistant intent preparation turn."""

import asyncio
import concurrent.futures
import threading

from chat.connection import Connection, Turn
from chat.delivery import plan as plan_delivery
from chat.delivery import terminal as terminal_delivery
from chat.delivery import uninstall as uninstall_delivery
from chat.projection import error_terminal
from fastapi import WebSocket
from history import context as history_context
from history import delivery as history_delivery
from history import store as history
from team import transport

from chat import assistant_route, lifecycle


async def _deliver_guidance(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    guidance: assistant_route.Guidance,
) -> None:
    try:
        await history_delivery.guidance(team_id, turn.history_id, guidance.code, guidance.reply)
    except history.HistoryUnavailableError, ValueError:
        event = error_terminal(503, "Admin chat history is unavailable")
    else:
        connection.assistant_reference = None
        event = {
            "type": "assistant-guidance",
            "team_id": team_id,
            "code": guidance.code,
            "reply": guidance.reply,
        }
    await terminal_delivery.turn(websocket, connection, turn, event)


async def _result(turn: Turn) -> assistant_route.Result:
    if turn.future is None:
        raise assistant_route.RouteError(503)
    try:
        result = await asyncio.wrap_future(turn.future)
    except asyncio.CancelledError:
        raise
    except assistant_route.RouteError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, transport.TeamRequestError) as exc:
        raise assistant_route.RouteError(503) from exc
    if not isinstance(result, assistant_route.Result):
        raise assistant_route.RouteError(503)
    return result


async def _deliver_result(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    operations: plan_delivery.Operations,
    fallback_payload: dict[str, object] | None,
) -> None:
    result = await _result(turn)
    if connection.closed:
        return
    if turn.stop_requested:
        await operations.finish_turn(websocket, connection, turn, {"type": "stopped"})
        return
    if result.guidance is not None:
        await _deliver_guidance(websocket, connection, turn, team_id, result.guidance)
        return
    if result.error_status is not None or result.intent == "unresolved":
        await operations.finish_turn(
            websocket,
            connection,
            turn,
            error_terminal(result.error_status or 422, "Assistant request could not be resolved"),
        )
        return
    if result.intent == "assistant-uninstall":
        if result.uninstall is None:
            raise assistant_route.RouteError(503)
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
        await operations.continue_turn(
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
        operations,
    )


async def deliver(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    operations: plan_delivery.Operations,
    *,
    fallback_payload: dict[str, object] | None = None,
) -> None:
    """Deliver the closed route result; failure never falls through to ordinary Brain."""
    try:
        await _deliver_result(
            websocket,
            connection,
            turn,
            team_id,
            payload,
            operations,
            fallback_payload,
        )
    except assistant_route.RouteError as exc:
        if not connection.closed and not turn.terminal_sent:
            await operations.finish_turn(
                websocket,
                connection,
                turn,
                exc.event or error_terminal(exc.status, "Assistant routing is unavailable; retry the message"),
            )
    finally:
        if connection.active is turn and turn.operation == "assistant-route":
            connection.active = None


def begin(
    connection: Connection,
    preparation: concurrent.futures.Future | None,
    locale: str,
    conversation: tuple[history_context.Entry, ...],
    request: dict[str, object],
) -> Turn:
    """Make the routed preparation of one sent message the connection's active turn."""
    turn = Turn(
        future=preparation,
        operation="assistant-route",
        locale=locale,
        lifecycle_stop=threading.Event(),
        history_id=lifecycle.take_history_id(connection),
        conversation=conversation,
        request=request,
    )
    connection.active = turn
    return turn
