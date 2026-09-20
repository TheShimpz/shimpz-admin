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
from history import store as history

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
    continuation = "none" if result.state == "installed" and plan.terminal else "dispatch"
    terminal = assistant_plan.event(
        plan,
        result.state,
        result.assistants,
        status=result.status,
        continuation=continuation if result.state == "installed" else None,
    )
    if not await _commit_install(team_id, turn, terminal):
        await operations.finish_turn(
            websocket,
            connection,
            turn,
            operations.error_terminal(503, "Admin chat history is unavailable"),
        )
        return
    if result.state != "installed" or continuation == "none":
        await operations.finish_turn(websocket, connection, turn, terminal)
    elif not await operations.send_event(websocket, terminal):
        connection.closed = True
    else:
        dispatch_payload = {**payload, "assistant_ids": list(plan.dispatch_ids)}
        await operations.continue_turn(websocket, connection, turn, team_id, dispatch_payload)


async def _commit_install(
    team_id: str,
    turn: Turn,
    terminal: Mapping[str, object],
) -> bool:
    if turn.history_id is None:
        return True
    try:
        committed = await asyncio.to_thread(
            history.append_install,
            team_id,
            turn.history_id,
            terminal,
        )
        if not committed:
            raise history.HistoryUnavailableError("chat history install was not committed")
    except history.HistoryUnavailableError, ValueError:
        return False
    return True


async def _deliver_already_installed(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    result: assistant_plan.AlreadyInstalled,
    operations: Operations,
) -> None:
    terminal = assistant_plan.already_installed_event(result)
    if not await _commit_install(team_id, turn, terminal):
        terminal = operations.error_terminal(503, "Admin chat history is unavailable")
    await operations.finish_turn(websocket, connection, turn, terminal)


async def deliver_result(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
    preparation: assistant_plan.Preparation,
    operations: Operations,
) -> None:
    """Deliver one already-resolved preparation without opening another worker lane."""
    if preparation.plan is None and preparation.already_installed is None and preparation.error_status is None:
        await operations.continue_turn(
            websocket,
            connection,
            turn,
            team_id,
            payload,
        )
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
    elif preparation.already_installed is not None:
        await _deliver_already_installed(
            websocket,
            connection,
            turn,
            team_id,
            preparation.already_installed,
            operations,
        )
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
