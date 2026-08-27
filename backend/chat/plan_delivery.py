"""Socket delivery for one admitted composed Assistant installation plan."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from chat.connection import Connection, Turn
from chat.executor import ExecutorSaturatedError
from fastapi import WebSocket

from chat import assistant_plan, lifecycle

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]
FinishTurn = Callable[[WebSocket, Connection, Turn, Mapping[str, object]], Awaitable[None]]
ContinueTurn = Callable[[WebSocket, Connection, Turn, str, dict[str, object]], Awaitable[None]]
ErrorTerminal = Callable[[object, str], dict[str, object]]


@dataclass(frozen=True, slots=True)
class Operations:
    send_event: SendEvent
    finish_turn: FinishTurn
    continue_turn: ContinueTurn
    error_terminal: ErrorTerminal


def _progress_channel() -> tuple[
    asyncio.Queue[tuple[dict[str, object], ...]],
    Callable[[tuple[dict[str, object], ...]], None],
]:
    queue: asyncio.Queue[tuple[dict[str, object], ...]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def report(items: tuple[dict[str, object], ...]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, items)

    return queue, report


async def _await_result(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    plan: assistant_plan.Plan,
    future: concurrent.futures.Future,
    queue: asyncio.Queue[tuple[dict[str, object], ...]],
    send_event: SendEvent,
) -> assistant_plan.Result | None:
    wrapped = asyncio.wrap_future(future)
    while not wrapped.done():
        update = asyncio.create_task(queue.get())
        done, _pending = await asyncio.wait({wrapped, update}, return_when=asyncio.FIRST_COMPLETED)
        if update in done:
            if not await send_event(websocket, assistant_plan.event(plan, "installing", update.result())):
                connection.closed = True
                if turn.lifecycle_stop is not None:
                    turn.lifecycle_stop.set()
                return None
        else:
            update.cancel()
            await asyncio.gather(update, return_exceptions=True)
    while not queue.empty() and not connection.closed:
        if not await send_event(websocket, assistant_plan.event(plan, "installing", queue.get_nowait())):
            connection.closed = True
            return None
    result = None
    with contextlib.suppress(Exception):
        result = await wrapped
    return result if isinstance(result, assistant_plan.Result) else None


async def _preparation_result(turn: Turn) -> assistant_plan.Preparation | None:
    preparation = None
    with contextlib.suppress(Exception):
        if turn.future is not None:
            preparation = await asyncio.wrap_future(turn.future)
    return preparation if isinstance(preparation, assistant_plan.Preparation) else None


async def _run_job(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    plan: assistant_plan.Plan,
    send_event: SendEvent,
) -> assistant_plan.Result | None:
    initial = assistant_plan.initial_items(plan)
    if not await send_event(websocket, assistant_plan.event(plan, "planned", initial)):
        connection.closed = True
        return None
    stop = threading.Event()
    turn.lifecycle_stop = stop
    queue, report = _progress_channel()
    try:
        future = lifecycle.submit_plan(plan, stop, report)
    except ExecutorSaturatedError:
        return assistant_plan.Result("failed", initial, 429)
    turn.future = future
    turn.operation = "assistant-plan"
    result = await _await_result(websocket, connection, turn, plan, future, queue, send_event)
    return result if result is not None else assistant_plan.Result("failed", initial, 502)


async def _deliver_admitted(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    plan: assistant_plan.Plan,
    operations: Operations,
) -> None:
    result = await _run_job(websocket, connection, turn, plan, operations.send_event)
    if connection.closed or result is None:
        return
    terminal = assistant_plan.event(plan, result.state, result.assistants, status=result.status)
    if result.state != "installed":
        await operations.finish_turn(websocket, connection, turn, terminal)
    elif not await operations.send_event(websocket, terminal):
        connection.closed = True
    else:
        dispatch_payload = {**payload, "assistant_ids": list(plan.dispatch_ids)}
        await operations.continue_turn(websocket, connection, turn, team_id, dispatch_payload)


async def deliver_preparation(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    operations: Operations,
) -> None:
    preparation = await _preparation_result(turn)
    if connection.closed:
        return
    if preparation is None or (preparation.plan is None and preparation.error_status is None):
        await operations.continue_turn(websocket, connection, turn, team_id, payload)
    elif preparation.error_status is not None:
        detail = "Assistant capability planning could not complete; retry the task"
        await operations.finish_turn(
            websocket,
            connection,
            turn,
            operations.error_terminal(preparation.error_status, detail),
        )
    elif turn.stop_requested:
        await operations.finish_turn(websocket, connection, turn, {"type": "stopped"})
    elif preparation.plan is not None:
        await _deliver_admitted(
            websocket,
            connection,
            turn,
            team_id,
            payload,
            preparation.plan,
            operations,
        )
