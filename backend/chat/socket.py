"""Bounded, session-authenticated WebSocket transport for local Team chat.

The browser speaks only ``shimpz.chat.v3``. Provider and Assistant secrets stay behind
:mod:`chat.local`; this module admits one mutating operation per socket, keeps Stop responsive on its
own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import contextvars
import logging
import os
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from fastapi import WebSocket, WebSocketDisconnect
from team import bridge as team

from chat import local
from protocol.http.v1 import websocket as chat_ws_common

CHAT_SUBPROTOCOL = "shimpz.chat.v3"
MAX_FRAME_BYTES = 512 * 1024
MAX_PUBLIC_ERROR_CHARS = 800
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
FrameError = chat_ws_common.FrameError
log = logging.getLogger("shimpz-admin")


class ExecutorSaturatedError(RuntimeError):
    """The local chat worker and queue budget has no free admission slot."""


def _submit_in_context(executor, function, /, *args):
    context = contextvars.copy_context()
    return executor.submit(context.run, function, *args)


class BoundedThreadPoolExecutor(concurrent.futures.ThreadPoolExecutor):
    """Admin-owned executor bounded for the Local chat workload."""

    def __init__(self, *, max_workers: int, max_outstanding: int, thread_name_prefix: str) -> None:
        if max_workers < 1 or max_outstanding < max_workers:
            raise ValueError("invalid bounded executor capacity")
        self._permits = threading.BoundedSemaphore(max_outstanding)
        super().__init__(max_workers=max_workers, thread_name_prefix=thread_name_prefix)

    def submit(self, fn, /, *args, **kwargs):
        if not self._permits.acquire(blocking=False):
            raise ExecutorSaturatedError("blocking worker admission is full")
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self._permits.release()
            raise
        future.add_done_callback(lambda _completed: self._permits.release())
        return future


# Turns and cancellation use separate bounded lanes: a slow provider can never consume the worker
# needed to revoke it. The local controller remains the authoritative per-Team admission boundary.
_TURN_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-turn",
)
_STOP_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=4,
    thread_name_prefix="shimpz-chat-stop",
)
_SYNC_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=4,
    thread_name_prefix="shimpz-chat-sync",
)


canonical_origin = chat_ws_common.canonical_origin


def _configured_origins() -> frozenset[str]:
    configured = os.environ.get("SHIMPZ_ADMIN_ALLOWED_ORIGINS", _DEFAULT_ORIGINS)
    items = [item.strip() for item in configured.split(",")]
    if not items or any(not item or canonical_origin(item) != item for item in items):
        raise RuntimeError("SHIMPZ_ADMIN_ALLOWED_ORIGINS must contain exact HTTP(S) origins")
    return frozenset(items)


STATIC_ORIGINS = _configured_origins()


async def receive_bounded_json(websocket: WebSocket) -> dict[str, object]:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    return chat_ws_common.decode_bounded_json_frame(message, MAX_FRAME_BYTES)


def _error_terminal(status: object, detail: str = "local chat request failed") -> dict[str, object]:
    return chat_ws_common.error_terminal(
        status,
        detail,
        fallback_detail="local chat request failed",
        max_detail_chars=MAX_PUBLIC_ERROR_CHARS,
    )


def _projected_event(
    response: object,
    team_id: str,
    allowed_types: frozenset[str],
) -> dict[str, object] | None:
    if not isinstance(response, local.PublicResponse):
        return None
    event = response.websocket_event(team_id)
    if event is None or event.get("type") not in allowed_types:
        return None
    return dict(event)


def turn_terminal(response: object, team_id: str) -> dict[str, object]:
    event = _projected_event(response, team_id, frozenset({"done", "error"}))
    return event if event is not None else _error_terminal(502, "local chat returned an invalid response")


def integration_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"integrations-required"}))


def _first_challenge(response: object, team_id: str) -> tuple[dict[str, object] | None, str | None]:
    challenge = integration_challenge_event(response, team_id)
    return (challenge, "integration") if challenge is not None else (None, None)


def _stop_accepted(response: object, team_id: str) -> bool | None:
    if not isinstance(response, local.PublicResponse) or not 200 <= response.status < 300:
        return None
    if response.body.get("team_id") != team_id:
        return None
    stopped = response.body.get("stopped")
    return stopped if isinstance(stopped, bool) else None


@dataclass(slots=True)
class _Turn:
    future: concurrent.futures.Future | None
    operation: str
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False


@dataclass(slots=True)
class _Connection:
    active: _Turn | None = None
    pending_challenge_id: str | None = None
    pending_challenge_type: str | None = None
    sync_task: asyncio.Task | None = None
    closed: bool = False


async def _send_event(websocket: WebSocket, event: Mapping[str, object]) -> bool:
    try:
        await websocket.send_json(dict(event))
    except WebSocketDisconnect, RuntimeError, OSError:
        return False
    return True


async def _send_terminal_once(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or turn.terminal_sent:
        return False
    turn.terminal_sent = True
    if not await _send_event(websocket, event):
        connection.closed = True
        return False
    return True


async def _deliver_turn(websocket: WebSocket, connection: _Connection, turn: _Turn, team_id: str) -> None:
    try:
        response = team.TeamResponse(502, {})
        # A provider callback may raise any ordinary exception. This process boundary must fail
        # closed while cancellation and process-control BaseExceptions continue to propagate.
        with contextlib.suppress(Exception):
            try:
                if turn.future is not None:
                    response = await asyncio.wrap_future(turn.future)
            except asyncio.CancelledError:
                raise
            except team.TeamRequestError:
                response = team.TeamResponse(400, {})
        if connection.closed or turn.stop_requested or turn.terminal_sent:
            return
        challenge, challenge_type = _first_challenge(response, team_id)
        if challenge is not None:
            connection.pending_challenge_id = challenge["challenge_id"]
            connection.pending_challenge_type = challenge_type
            if not await _send_event(websocket, challenge):
                connection.closed = True
            return
        if isinstance(response, team.TeamResponse) and (
            response.status == 428
            or (isinstance(response.body, dict) and response.body.get("status") == "integrations-required")
        ):
            event = _error_terminal(502, "the Assistant challenge was invalid")
        else:
            event = turn_terminal(response, team_id)
        if event.get("type") == "done":
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
        await _send_terminal_once(websocket, connection, turn, event)
    finally:
        if connection.active is turn:
            connection.active = None


def _sync_snapshot(team_id: str) -> tuple[object, object | None]:
    pending_integration = local.pending_integrations(team_id)
    integration_challenge = integration_challenge_event(pending_integration, team_id)
    if integration_challenge is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn.
        resumed = local.resume_integrations(team_id, integration_challenge["challenge_id"])
        return pending_integration, resumed
    return pending_integration, None


def _is_empty_pending(response: object, team_id: str) -> bool:
    return (
        isinstance(response, team.TeamResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and response.body == {"team_id": team_id, "status": "none"}
    )


def _pending_error(response: object, team_id: str, challenge_type: str) -> dict[str, object]:
    if (
        isinstance(response, team.TeamResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and not 200 <= response.status < 300
    ):
        return turn_terminal(response, team_id)
    return _error_terminal(502, f"the Assistant {challenge_type} challenge was invalid")


async def _deliver_integration_sync(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    pending_response: object,
    resumed_response: object,
) -> bool:
    """Deliver an explicitly resumed integration gate; return whether it consumed sync."""
    pending = integration_challenge_event(pending_response, team_id)
    if pending is None:
        if _is_empty_pending(pending_response, team_id):
            await _send_event(websocket, {"type": "sync-empty"})
            return True
        await _send_event(websocket, _pending_error(pending_response, team_id, "integration"))
        return True
    if resumed_response is None:
        await _send_event(websocket, _error_terminal(502, "the Assistant integration challenge was invalid"))
        return True

    resumed, challenge_type = _first_challenge(resumed_response, team_id)
    if resumed is not None:
        pending_turn_id = pending_response.body.get("turn_id")
        resumed_turn_id = resumed_response.body.get("turn_id")
        if pending_turn_id != resumed_turn_id:
            await _send_event(websocket, _error_terminal(502, "the Assistant integration challenge was invalid"))
            return True
        connection.pending_challenge_id = resumed["challenge_id"]
        connection.pending_challenge_type = challenge_type
        if not await _send_event(websocket, resumed):
            connection.closed = True
        return True

    if isinstance(resumed_response, team.TeamResponse) and (
        resumed_response.status == 428
        or (isinstance(resumed_response.body, dict) and resumed_response.body.get("status") == "integrations-required")
    ):
        event = _error_terminal(502, "the Assistant integration challenge was invalid")
    else:
        event = turn_terminal(resumed_response, team_id)
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    await _send_event(websocket, event)
    return True


async def _load_sync_snapshot(
    websocket: WebSocket,
    team_id: str,
) -> tuple[object, object | None] | None:
    try:
        future = _submit_in_context(_SYNC_EXECUTOR, _sync_snapshot, team_id)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return None
    snapshot = None
    with contextlib.suppress(Exception):
        snapshot = await asyncio.wrap_future(future)
    if snapshot is None:
        await _send_event(websocket, _error_terminal(502))
    return snapshot


async def _deliver_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    task = asyncio.current_task()
    try:
        snapshot = await _load_sync_snapshot(websocket, team_id)
        if snapshot is None:
            return
        pending_integration_response, resumed_integration_response = snapshot
        if connection.closed:
            return
        if not await _deliver_integration_sync(
            websocket,
            connection,
            team_id,
            pending_integration_response,
            resumed_integration_response,
        ):
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
    finally:
        if connection.sync_task is task:
            connection.sync_task = None


async def _run_stop(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    team_id: str,
    *,
    emit: bool,
) -> None:
    try:
        response = team.TeamResponse(502, {})
        # Stop has the same fail-closed callback boundary as turn delivery.
        with contextlib.suppress(Exception):
            try:
                response = await asyncio.wrap_future(_submit_in_context(_STOP_EXECUTOR, local.stop, team_id))
            except ExecutorSaturatedError:
                response = team.TeamResponse(429, {})
        accepted = _stop_accepted(response, team_id)
        if not emit or connection.closed or turn.terminal_sent:
            return
        if accepted is True:
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
            await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
        elif accepted is None:
            status = response.status if isinstance(response, team.TeamResponse) else 502
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                _error_terminal(status, "chat turn could not be stopped"),
            )
        elif turn.operation == "pending-stop":
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                _error_terminal(409, "no active chat turn"),
            )
        # ``False`` races safely with a turn that has already finished; its normal terminal wins.
    finally:
        turn.stop_task = None
        if turn.operation == "pending-stop" and turn.terminal_sent and connection.active is turn:
            connection.active = None


async def _finish_cancelled_turn(websocket: WebSocket, connection: _Connection, turn: _Turn) -> None:
    try:
        await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
    finally:
        if connection.active is turn:
            connection.active = None


def _request_stop(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    team_id: str,
    *,
    emit: bool,
) -> asyncio.Task | None:
    if turn.stop_requested:
        return turn.stop_task
    turn.stop_requested = True
    cancelled = turn.future is not None and turn.future.cancel()
    if cancelled and connection.pending_challenge_id is None:
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_finish_cancelled_turn(websocket, connection, turn))
        return turn.stop_task
    turn.stop_task = asyncio.create_task(_run_stop(websocket, connection, turn, team_id, emit=emit))
    return turn.stop_task


async def _dispatch_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    if connection.sync_task is not None or connection.active is not None:
        await _send_event(websocket, _error_terminal(409, "a chat operation is already active"))
        return
    connection.sync_task = asyncio.create_task(_deliver_sync(websocket, connection, team_id))


async def _dispatch_chat(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
) -> None:
    if set(frame) != {"type", "message", "files", "assistant_ids"}:
        await _send_event(
            websocket,
            _error_terminal(400, "chat frame requires message, files, and assistant_ids"),
        )
        return
    try:
        payload = team.canonical_chat_payload({key: value for key, value in frame.items() if key != "type"})
    except team.TeamRequestError:
        await _send_event(websocket, _error_terminal(400, "invalid chat request"))
        return
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, _error_terminal(409, "a chat turn is already active"))
        return
    if connection.pending_challenge_id is not None:
        await _send_event(
            websocket,
            _error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return
    try:
        future = _submit_in_context(_TURN_EXECUTOR, local.turn, team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation="chat")
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


async def _dispatch_stop(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    if connection.active is None and connection.pending_challenge_id is None:
        await _send_event(websocket, _error_terminal(409, "no active chat turn"))
        return
    if connection.active is None:
        connection.active = _Turn(future=None, operation="pending-stop")
    _request_stop(websocket, connection, connection.active, team_id, emit=True)


async def _dispatch(websocket: WebSocket, connection: _Connection, team_id: str, frame: dict[str, object]) -> None:
    frame_type = frame.get("type")
    if frame_type == "sync" and set(frame) == {"type"}:
        await _dispatch_sync(websocket, connection, team_id)
    elif frame_type == "chat":
        await _dispatch_chat(websocket, connection, team_id, frame)
    elif frame_type == "stop" and set(frame) == {"type"}:
        await _dispatch_stop(websocket, connection, team_id)
    else:
        await _send_event(websocket, _error_terminal(400, "unsupported chat frame"))


def _has_subprotocol(websocket: WebSocket) -> bool:
    protocols = websocket.scope.get("subprotocols", [])
    return protocols == [CHAT_SUBPROTOCOL]


async def _session_status(
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    cookies: Mapping[str, str],
) -> str:
    status = "unavailable"
    with contextlib.suppress(Exception):
        status = "active" if await session_ok(cookies) is True else "invalid"
    return status


async def _admit(
    websocket: WebSocket,
    team_id: object,
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    allowed_origins: Callable[[], frozenset[str]],
) -> str | None:
    origin = canonical_origin(websocket.headers.get("origin"))
    try:
        admitted_origins = allowed_origins()
    except Exception:
        log.exception("chat WebSocket origin authority is unavailable")
        await websocket.close(code=1013)
        return None
    if origin is None or origin not in admitted_origins:
        log.info("chat WebSocket origin denied: %s", origin[:200] if origin is not None else "invalid")
        await websocket.close(code=4403)
        return None
    if not _has_subprotocol(websocket):
        await websocket.close(code=4406)
        return None
    try:
        canonical_id = team.canonical_team_id(team_id)
    except team.TeamRequestError:
        await websocket.close(code=4400)
        return None
    session_status = await _session_status(session_ok, websocket.cookies)
    if session_status != "active":
        await websocket.close(code=1013 if session_status == "unavailable" else 4401)
        return None
    return canonical_id


async def serve(
    websocket: WebSocket,
    team_id: object,
    *,
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    request_scope: Callable[[Mapping[str, str]], contextlib.AbstractContextManager[None]],
    allowed_origins: Callable[[], frozenset[str]],
) -> None:
    """Serve one authenticated local chat socket without letting it outlive its Admin session."""
    canonical_id = await _admit(websocket, team_id, session_ok, allowed_origins)
    if canonical_id is None:
        return

    with request_scope(websocket.cookies):
        await websocket.accept(subprotocol=CHAT_SUBPROTOCOL)
        connection = _Connection()
        try:
            while True:
                try:
                    frame = await receive_bounded_json(websocket)
                except FrameError as exc:
                    await _send_event(websocket, _error_terminal(exc.status, exc.detail))
                    connection.closed = True
                    await websocket.close(code=exc.close_code)
                    return
                # A week-long cookie can expire or be rotated while a socket is open. Revalidating the
                # signed token before every operation prevents that connection from extending authority.
                session_status = await _session_status(session_ok, websocket.cookies)
                if session_status != "active":
                    connection.closed = True
                    await websocket.close(code=1013 if session_status == "unavailable" else 4401)
                    return
                await _dispatch(websocket, connection, canonical_id, frame)
        except WebSocketDisconnect, RuntimeError, OSError:
            connection.closed = True
        finally:
            connection.closed = True
            sync_task = connection.sync_task
            if sync_task is not None:
                sync_task.cancel()
                await asyncio.gather(sync_task, return_exceptions=True)
            active = connection.active
            if active is None and connection.pending_challenge_type == "secret":
                active = _Turn(future=None, operation="pending-stop")
                connection.active = active
                _request_stop(websocket, connection, active, canonical_id, emit=False)
            if active is not None:
                stop_task = active.stop_task
                if active.future is not None and not active.future.done():
                    stop_task = _request_stop(websocket, connection, active, canonical_id, emit=False)
                if stop_task is not None:
                    with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                        await asyncio.wait_for(asyncio.shield(stop_task), timeout=15)
                if active.delivery is not None:
                    active.delivery.cancel()
                    await asyncio.gather(active.delivery, return_exceptions=True)
