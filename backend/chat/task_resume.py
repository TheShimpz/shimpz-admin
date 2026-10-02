"""One-use Admin task resumption after a chat transport reconnect."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import REQUESTS, Connection, Turn, canonical_sent_request
from chat.delivery import plan as plan_delivery
from chat.delivery import route as route_delivery
from chat.executor import ExecutorSaturatedError
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history
from team import bridge as team

from chat import assistant_proposal, lifecycle

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    plan: plan_delivery.Operations
    error_terminal: ErrorTerminal


def _canonical_payloads(frame: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    if (
        set(frame)
        != {
            "type",
            "message",
            "objective",
            "files",
            "assistant_ids",
            "objective_assistant_ids",
            "locale",
            "timezone",
            "request",
        }
        or canonical_sent_request(frame["request"]) is None
    ):
        raise team.TeamRequestError("invalid task resume request")
    payload = team.canonical_chat_payload(
        {
            "message": frame["message"],
            "files": frame["files"],
            "assistant_ids": frame["assistant_ids"],
            "locale": frame["locale"],
            "timezone": frame["timezone"],
        }
    )
    objective = team.canonical_chat_payload(
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
        raise team.TeamRequestError("invalid task resume request")
    return payload, objective


async def admit(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    operations: Operations,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]] | None:
    """The resumed turn's payload, its objective, and the identity of its logical send, or None after a terminal."""
    try:
        payloads = _canonical_payloads(frame)
    except team.TeamRequestError:
        await operations.send_event(websocket, operations.error_terminal(400, "invalid task resume request"))
        return None
    if connection.active is not None or connection.sync_task is not None or connection.lifecycle is not None:
        await operations.send_event(websocket, operations.error_terminal(409, "a chat turn is already active"))
        return None
    if connection.pending_challenge_id is not None:
        await operations.send_event(
            websocket,
            operations.error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return None
    identity = REQUESTS.identity(team_id, canonical_sent_request(frame["request"]), payloads[1])
    if identity is None:
        await operations.send_event(
            websocket,
            operations.error_terminal(410, "this message can no longer be sent again; send it as a new message"),
        )
        return None
    return (*payloads, identity)


async def dispatch(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    operations: Operations,
) -> None:
    admitted = await admit(websocket, connection, team_id, frame, operations)
    if admitted is None:
        return
    payload, objective, identity = admitted
    try:
        history_id = await history_delivery.admit(team_id, payload["message"])
        # The window ends before the continuation row, so it still holds the original objective and the reply that
        # asked for a capability; the objective itself runs once, as this turn's message.
        conversation = await history_delivery.conversation(team_id, history_id)
    except history.HistoryUnavailableError, ValueError:
        await operations.send_event(websocket, operations.error_terminal(503, "Admin chat history is unavailable"))
        return
    connection.admitted_history_id = history_id
    try:
        preparation = lifecycle.submit_resume(team_id, objective)
    except ExecutorSaturatedError:
        await operations.send_event(websocket, operations.error_terminal(429, "Assistant routing capacity reached"))
        return
    turn = Turn(
        future=preparation,
        operation="assistant-route",
        locale=objective["locale"],
        lifecycle_stop=threading.Event(),
        history_id=connection.admitted_history_id,
        conversation=conversation,
        request=identity,
    )
    connection.admitted_history_id = None
    connection.active = turn
    turn.delivery = asyncio.create_task(
        route_delivery.deliver(
            websocket,
            connection,
            turn,
            team_id,
            objective,
            route_delivery.Operations(
                plan=operations.plan,
                finish_turn=operations.plan.finish_turn,
                error_terminal=operations.error_terminal,
            ),
            fallback_payload=payload,
        )
    )
