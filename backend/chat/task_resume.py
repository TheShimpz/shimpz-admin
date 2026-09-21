"""One-use Admin task resumption after a chat transport reconnect."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import Connection, Turn
from chat.delivery import plan as plan_delivery
from chat.delivery import route as route_delivery
from chat.executor import ExecutorSaturatedError
from fastapi import WebSocket
from history import delivery as history_delivery
from history import store as history
from team import bridge as team

from chat import assistant_proposal, lifecycle
from protocol.http.v1 import payload as team_contract

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    plan: plan_delivery.Operations
    error_terminal: ErrorTerminal


def _canonical_payloads(frame: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    if set(frame) != {
        "type",
        "message",
        "objective",
        "files",
        "assistant_ids",
        "objective_assistant_ids",
    }:
        raise team.TeamRequestError("invalid task resume request")
    payload = team.canonical_chat_payload(
        {
            "message": frame["message"],
            "files": frame["files"],
            "assistant_ids": frame["assistant_ids"],
        }
    )
    objective = team.canonical_chat_payload(
        {
            "message": frame["objective"],
            "files": [],
            "assistant_ids": frame["objective_assistant_ids"],
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
    frame: dict[str, object],
    operations: Operations,
) -> tuple[dict[str, object], dict[str, object]] | None:
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
    return payloads


async def dispatch(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    operations: Operations,
) -> None:
    admitted = await admit(websocket, connection, frame, operations)
    if admitted is None:
        return
    payload, objective = admitted
    try:
        history_id = await history_delivery.admit(team_id, payload["message"])
    except history.HistoryUnavailableError, ValueError:
        await operations.send_event(websocket, operations.error_terminal(503, "Admin chat history is unavailable"))
        return
    connection.admitted_history_id = history_id
    try:
        preparation = lifecycle.submit_resume(team_id, objective)
    except ExecutorSaturatedError:
        await operations.send_event(websocket, operations.error_terminal(429, "Assistant routing capacity reached"))
        return
    language_exemplar = team_contract.canonical_language_exemplar(objective["message"])
    turn = Turn(
        future=preparation,
        operation="assistant-route",
        language_exemplar=language_exemplar,
        lifecycle_stop=threading.Event(),
        history_id=connection.admitted_history_id,
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
