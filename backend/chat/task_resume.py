"""One-use Admin task resumption after a chat transport reconnect."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import Connection, Turn
from fastapi import WebSocket
from team import bridge as team

from chat import assistant_proposal, lifecycle, plan_delivery
from protocol.http.v1 import payload as team_contract

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]
StartDirect = Callable[[WebSocket, Connection, str, dict[str, object], str | None], Awaitable[None]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    start_direct: StartDirect
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
        or assistant_proposal.uninstall_requested(objective["message"])
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
    preparation = lifecycle.submit_preparation(team_id, objective)
    if preparation is None:
        await operations.start_direct(
            websocket,
            connection,
            team_id,
            payload,
            team_contract.canonical_language_exemplar(payload["message"]),
        )
        return
    turn = Turn(
        future=preparation,
        operation="capability-plan",
        language_exemplar=team_contract.canonical_language_exemplar(objective["message"]),
        lifecycle_stop=threading.Event(),
    )
    connection.active = turn
    turn.delivery = asyncio.create_task(
        plan_delivery.deliver_preparation(
            websocket,
            connection,
            turn,
            team_id,
            objective,
            operations.plan,
            fallback_payload=payload,
        )
    )
