"""One-use Admin task resumption after a chat transport reconnect."""

import asyncio

from chat.connection import Connection, request_identity
from chat.delivery import gated
from chat.delivery import plan as plan_delivery
from chat.delivery import route as route_delivery
from chat.executor import ExecutorSaturatedError
from chat.projection import error_terminal
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history
from team import transport

from chat import assistant_proposal, lifecycle, payloads


def _canonical_payloads(frame: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    if set(frame) != {
        "type",
        "message",
        "objective",
        "files",
        "assistant_ids",
        "objective_assistant_ids",
        "locale",
        "timezone",
    }:
        raise transport.TeamRequestError("invalid task resume request")
    payload = payloads.canonical_chat_payload(
        {
            "message": frame["message"],
            "files": frame["files"],
            "assistant_ids": frame["assistant_ids"],
            "locale": frame["locale"],
            "timezone": frame["timezone"],
        }
    )
    objective = payloads.canonical_chat_payload(
        {
            "message": frame["objective"],
            "files": [],
            "assistant_ids": frame["objective_assistant_ids"],
            "locale": frame["locale"],
            "timezone": frame["timezone"],
        }
    )
    if (
        payload["files"]
        or payload["assistant_ids"] != objective["assistant_ids"]
        or not assistant_proposal.capability_continuation(payload["message"])
        or assistant_proposal.capability_continuation(objective["message"])
    ):
        raise transport.TeamRequestError("invalid task resume request")
    return payload, objective


async def admit(
    websocket: WebSocket,
    connection: Connection,
    frame: dict[str, object],
    operations: plan_delivery.Operations,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]] | None:
    """The resumed turn's payload, its objective, and the identity of its logical send, or None after a terminal."""
    try:
        canonical = _canonical_payloads(frame)
    except transport.TeamRequestError:
        await operations.send_event(websocket, error_terminal(400, "invalid task resume request"))
        return None
    if connection.active is not None or connection.sync_task is not None or connection.lifecycle is not None:
        await operations.send_event(websocket, error_terminal(409, "a chat turn is already active"))
        return None
    if connection.pending_challenge_id is not None:
        await operations.send_event(
            websocket,
            error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return None
    return (*canonical, request_identity())


async def dispatch(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    operations: plan_delivery.Operations,
) -> None:
    admitted = await admit(websocket, connection, frame, operations)
    if admitted is None:
        return
    payload, objective, identity = admitted
    try:
        # A resumed task never carries files, so its turn is never attached.
        history_id = await history_delivery.admit(team_id, payload["message"])
        # The window ends before the continuation row, so it still holds the original objective and the reply that
        # asked for a capability; the objective itself runs once, as this turn's message.
        conversation = await history_delivery.conversation(team_id, history_id)
    except ExecutorSaturatedError:
        await operations.send_event(websocket, error_terminal(429, "Admin chat history capacity reached"))
        return
    except history.HistoryUnavailableError, ValueError:
        await operations.send_event(websocket, error_terminal(503, "Admin chat history is unavailable"))
        return
    connection.admitted_history_id = history_id
    turn = route_delivery.begin(connection, None, objective["locale"], conversation, identity)
    turn.operation = "queued"

    async def route() -> None:
        try:
            turn.future = lifecycle.submit_resume(team_id, objective)
        except ExecutorSaturatedError:
            await operations.finish_turn(
                websocket, connection, turn, error_terminal(429, "Assistant routing capacity reached")
            )
            return
        turn.operation = "assistant-route"
        await route_delivery.deliver(
            websocket, connection, turn, team_id, objective, operations, fallback_payload=payload
        )

    turn.delivery = asyncio.create_task(gated.run(websocket, connection, turn, route, operations.finish_turn))
