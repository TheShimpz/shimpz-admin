"""Bounded, session-authenticated WebSocket transport for local Team chat.

The browser speaks only ``shimpz.chat.v6``. Provider and Assistant secrets stay behind
:mod:`chat.local`; this module admits one mutating operation per socket, keeps Stop responsive on its
own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import logging
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from chat.assistant_proposal import InstallProposal
from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import WebSocket, WebSocketDisconnect
from team import bridge as team

from chat import human, local
from chat import install as install_flow
from chat import progress as progress_transport
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

CHAT_SUBPROTOCOL = "shimpz.chat.v6"
MAX_FRAME_BYTES = 128 * 1024
MAX_PUBLIC_ERROR_CHARS = 800
STOP_RESULT_WAIT_SECONDS = 15
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
FrameError = chat_ws_common.FrameError
log = logging.getLogger("shimpz-admin")


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


def human_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"human-required"}))


def _first_challenge(response: object, team_id: str) -> tuple[dict[str, object] | None, str | None]:
    challenge = integration_challenge_event(response, team_id)
    if challenge is not None:
        return challenge, "integration"
    challenge = human_challenge_event(response, team_id)
    return (challenge, "human") if challenge is not None else (None, None)


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
    progress: asyncio.Queue[dict[str, object]] | None = None
    discovery_future: concurrent.futures.Future | None = None
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False
    language_exemplar: str | None = field(default=None, repr=False)


@dataclass(slots=True)
class _Connection:
    active: _Turn | None = None
    pending_challenge_id: str | None = None
    pending_challenge_type: str | None = None
    pending_human_request: dict[str, object] | None = None
    sync_task: asyncio.Task | None = None
    sync_terminal_sent: bool = False
    install_proposal: InstallProposal | None = None
    install: install_flow.Operation | None = None
    closed: bool = False


@dataclass(frozen=True, slots=True)
class _SyncSnapshot:
    challenge_type: str
    pending: object
    resumed: object | None = None


def _remember_challenge(
    connection: _Connection,
    challenge: dict[str, object],
    challenge_type: str,
) -> None:
    connection.pending_challenge_id = challenge["challenge_id"]
    connection.pending_challenge_type = challenge_type
    request = challenge.get("request")
    connection.pending_human_request = (
        dict(request) if challenge_type == "human" and isinstance(request, dict) else None
    )


def _forget_challenge(connection: _Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None


def _cancel_discovery(turn: _Turn) -> None:
    install_flow.cancel_discovery(turn.discovery_future)


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


async def _send_sync_terminal_once(
    websocket: WebSocket,
    connection: _Connection,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or connection.sync_terminal_sent:
        return False
    connection.sync_terminal_sent = True
    if not await _send_event(websocket, event):
        connection.closed = True
        return False
    return True


async def _send_sync_event(
    websocket: WebSocket,
    connection: _Connection,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or connection.sync_terminal_sent:
        return False
    if not await _send_event(websocket, event):
        connection.closed = True
        return False
    return True


def _progress_channel() -> tuple[
    asyncio.Queue[dict[str, object]],
    Callable[[dict[str, object]], None],
]:
    return progress_transport.channel()


async def _await_progress_result(
    websocket: WebSocket,
    connection: _Connection,
    future: concurrent.futures.Future,
    progress: asyncio.Queue[dict[str, object]],
    inactive: Callable[[], bool],
) -> object | None:
    return await progress_transport.await_result(
        future,
        progress,
        inactive,
        lambda event: _send_event(websocket, event),
        lambda: setattr(connection, "closed", True),
    )


async def _await_turn_response(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
) -> object:
    if turn.future is None or turn.progress is None:
        return team.TeamResponse(502, {})
    result = await _await_progress_result(
        websocket,
        connection,
        turn.future,
        turn.progress,
        lambda: connection.closed or turn.terminal_sent,
    )
    return team.TeamResponse(502, {}) if result is None else result


async def _stop_closed_turn(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    team_id: str,
) -> None:
    if not connection.closed or turn.terminal_sent or turn.future is None or turn.future.done():
        return
    stop_task = _request_stop(websocket, connection, turn, team_id, emit=False)
    if stop_task is not None:
        with contextlib.suppress(asyncio.CancelledError, TimeoutError):
            await asyncio.wait_for(
                asyncio.shield(stop_task),
                timeout=STOP_RESULT_WAIT_SECONDS,
            )


async def _deliver_turn(websocket: WebSocket, connection: _Connection, turn: _Turn, team_id: str) -> None:
    try:
        response = team.TeamResponse(502, {})
        # A provider callback may raise any ordinary exception. This process boundary must fail
        # closed while cancellation and process-control BaseExceptions continue to propagate.
        with contextlib.suppress(Exception):
            try:
                if turn.future is not None:
                    response = await _await_turn_response(websocket, connection, turn)
            except asyncio.CancelledError:
                raise
            except team.TeamRequestError:
                response = team.TeamResponse(400, {})
        if turn.stop_requested and turn.stop_task is not None:
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(
                    asyncio.shield(turn.stop_task),
                    timeout=STOP_RESULT_WAIT_SECONDS,
                )
        await _stop_closed_turn(websocket, connection, turn, team_id)
        if connection.closed or turn.terminal_sent:
            return
        challenge, challenge_type = _first_challenge(response, team_id)
        if challenge is not None and challenge_type is not None:
            _cancel_discovery(turn)
            connection.install_proposal = None
            _remember_challenge(connection, challenge, challenge_type)
            if not await _send_event(websocket, challenge):
                connection.closed = True
            return
        if isinstance(response, team.TeamResponse) and (
            response.status == 428
            or (
                isinstance(response.body, dict)
                and response.body.get("status") in {"human-required", "integrations-required"}
            )
        ):
            event = _error_terminal(502, "the Assistant challenge was invalid")
        else:
            event = turn_terminal(response, team_id)
        if event.get("type") == "done":
            _forget_challenge(connection)
        event = await install_flow.attach_proposal(
            connection,
            turn.discovery_future,
            team_id,
            event,
            language_exemplar=turn.language_exemplar,
        )
        await _send_terminal_once(websocket, connection, turn, event)
    finally:
        if connection.active is turn:
            connection.active = None


def _sync_snapshot(
    team_id: str,
    progress: Callable[[dict[str, object]], None],
) -> _SyncSnapshot:
    pending_integration = local.pending_integrations(team_id)
    integration_challenge = integration_challenge_event(pending_integration, team_id)
    if integration_challenge is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn.
        resumed = local.resume_integrations(team_id, integration_challenge["challenge_id"], progress)
        return _SyncSnapshot("integration", pending_integration, resumed)
    if not _is_empty_pending(pending_integration, team_id):
        return _SyncSnapshot("integration", pending_integration)
    return _SyncSnapshot("human", local.pending_human(team_id))


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
) -> None:
    """Deliver one explicit integration synchronization result."""
    pending = integration_challenge_event(pending_response, team_id)
    if pending is None:
        if _is_empty_pending(pending_response, team_id):
            _forget_challenge(connection)
            await _send_sync_event(websocket, connection, {"type": "sync-empty"})
            return
        await _send_sync_terminal_once(
            websocket,
            connection,
            _pending_error(pending_response, team_id, "integration"),
        )
        return
    if resumed_response is None:
        await _send_sync_terminal_once(
            websocket,
            connection,
            _error_terminal(502, "the Assistant integration challenge was invalid"),
        )
        return

    resumed, challenge_type = _first_challenge(resumed_response, team_id)
    if resumed is not None and challenge_type is not None:
        pending_turn_id = pending_response.body.get("turn_id")
        resumed_turn_id = resumed_response.body.get("turn_id")
        if pending_turn_id != resumed_turn_id:
            await _send_sync_terminal_once(
                websocket,
                connection,
                _error_terminal(502, "the Assistant integration challenge was invalid"),
            )
            return
        _remember_challenge(connection, resumed, challenge_type)
        await _send_sync_event(websocket, connection, resumed)
        return

    if isinstance(resumed_response, team.TeamResponse) and (
        resumed_response.status == 428
        or (
            isinstance(resumed_response.body, dict)
            and resumed_response.body.get("status") in {"human-required", "integrations-required"}
        )
    ):
        event = _error_terminal(502, "the Assistant integration challenge was invalid")
    else:
        event = turn_terminal(resumed_response, team_id)
    _forget_challenge(connection)
    await _send_sync_terminal_once(websocket, connection, event)


async def _deliver_human_sync(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    pending_response: object,
) -> None:
    pending = human_challenge_event(pending_response, team_id)
    if pending is not None:
        _remember_challenge(connection, pending, "human")
        await _send_sync_event(websocket, connection, pending)
        return
    if _is_empty_pending(pending_response, team_id):
        _forget_challenge(connection)
        await _send_sync_event(websocket, connection, {"type": "sync-empty"})
        return
    await _send_sync_terminal_once(
        websocket,
        connection,
        _pending_error(pending_response, team_id, "human"),
    )


async def _load_sync_snapshot(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
) -> _SyncSnapshot | None:
    progress, report = _progress_channel()
    try:
        future = submit_in_context(_SYNC_EXECUTOR, _sync_snapshot, team_id, report)
    except ExecutorSaturatedError:
        await _send_sync_terminal_once(
            websocket,
            connection,
            _error_terminal(429, "local chat capacity reached"),
        )
        return None
    snapshot = None
    with contextlib.suppress(Exception):
        snapshot = await _await_progress_result(
            websocket,
            connection,
            future,
            progress,
            lambda: connection.closed or connection.sync_terminal_sent,
        )
    if snapshot is None and not connection.closed:
        await _send_sync_terminal_once(websocket, connection, _error_terminal(502))
    return snapshot


async def _deliver_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    task = asyncio.current_task()
    try:
        completed = False
        with contextlib.suppress(Exception):
            snapshot = await _load_sync_snapshot(websocket, connection, team_id)
            if snapshot is None:
                return
            if connection.closed:
                return
            if snapshot.challenge_type == "human":
                await _deliver_human_sync(websocket, connection, team_id, snapshot.pending)
            else:
                await _deliver_integration_sync(
                    websocket,
                    connection,
                    team_id,
                    snapshot.pending,
                    snapshot.resumed,
                )
            completed = True
        if (
            not completed
            and not connection.closed
            and not connection.sync_terminal_sent
            and not await _send_sync_terminal_once(
                websocket,
                connection,
                _error_terminal(502),
            )
        ):
            connection.closed = True
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
                response = await asyncio.wrap_future(submit_in_context(_STOP_EXECUTOR, local.stop, team_id))
            except ExecutorSaturatedError:
                response = team.TeamResponse(429, {})
        accepted = _stop_accepted(response, team_id)
        if not emit or connection.closed or turn.terminal_sent:
            return
        if accepted is True:
            _forget_challenge(connection)
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
    _cancel_discovery(turn)
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
    connection.sync_terminal_sent = False
    connection.sync_task = asyncio.create_task(_deliver_sync(websocket, connection, team_id))


def _authenticated_denial(response: object) -> bool:
    return (
        isinstance(response, local.PublicResponse)
        and response.status == 409
        and response.body == {"code": "human-request-denied"}
    )


async def _deliver_human_response(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    future: concurrent.futures.Future,
    progress: asyncio.Queue[dict[str, object]],
    authentication_failure: tuple[int, str] | None,
) -> None:
    task = asyncio.current_task()
    try:
        response = None
        with contextlib.suppress(Exception):
            response = await _await_progress_result(
                websocket,
                connection,
                future,
                progress,
                lambda: connection.closed or connection.sync_terminal_sent,
            )
        if response is None or connection.closed:
            if not connection.closed:
                await _send_sync_terminal_once(websocket, connection, _error_terminal(502))
            return
        _forget_challenge(connection)
        if authentication_failure is not None:
            event = (
                _error_terminal(*authentication_failure)
                if _authenticated_denial(response)
                else turn_terminal(response, team_id)
            )
            await _send_sync_terminal_once(websocket, connection, event)
            return
        challenge, challenge_type = _first_challenge(response, team_id)
        if challenge is not None and challenge_type is not None:
            _remember_challenge(connection, challenge, challenge_type)
            await _send_sync_event(websocket, connection, challenge)
            return
        await _send_sync_terminal_once(websocket, connection, turn_terminal(response, team_id))
    finally:
        if connection.sync_task is task:
            connection.sync_task = None


async def _human_payload(
    frame: dict[str, object],
    request: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
) -> tuple[
    dict[str, object] | None,
    dict[str, str] | None,
    dict[str, object] | None,
    tuple[int, str] | None,
]:
    canonical = chat_ws_common.canonical_human_response(frame)
    challenge_id = canonical["challenge_id"]
    if canonical["decision"] == "deny":
        return {"challenge_id": challenge_id, "decision": "deny"}, None, None, None
    value = canonical.pop("value")
    if not human.browser_value(request, value):
        raise FrameError(400, "human response does not match its request")
    kind = request.get("kind")
    if kind not in human.AUTH_KINDS:
        return (
            {
                "challenge_id": challenge_id,
                "decision": "submit",
                "value": value,
            },
            None,
            None,
            None,
        )
    frame.pop("value", None)
    password = value
    # human.browser_value already proves that authentication responses are bounded strings.
    result = human.AuthenticationResult("unavailable")
    with contextlib.suppress(Exception):
        result = await authenticate(kind, password)
    del password
    del value
    if result.status == "verified":
        return (
            {
                "challenge_id": challenge_id,
                "decision": "submit",
                "value": True,
            },
            {"kind": kind, "challenge_id": challenge_id},
            None,
            None,
        )
    if result.status in {"denied", "locked"}:
        reason = "authentication-denied" if result.status == "denied" else "authentication-locked"
        return (
            None,
            None,
            {
                "type": "human-response-rejected",
                "challenge_id": challenge_id,
                "reason": reason,
                "attempts_remaining": result.attempts_remaining,
                "retry_after": result.retry_after,
            },
            None,
        )
    return (
        {"challenge_id": challenge_id, "decision": "deny"},
        None,
        None,
        (503, "authentication is unavailable"),
    )


async def _dispatch_human_response(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
) -> None:
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, _error_terminal(409, "a chat operation is already active"))
        return
    request = connection.pending_human_request
    if (
        connection.pending_challenge_type != "human"
        or connection.pending_challenge_id != frame.get("challenge_id")
        or request is None
    ):
        await _send_event(websocket, _error_terminal(409, "the human challenge is not pending"))
        return
    try:
        payload, assurance, rejection, authentication_failure = await _human_payload(frame, request, authenticate)
        if rejection is not None:
            if not await _send_event(websocket, rejection):
                connection.closed = True
            return
        if payload is None:
            raise FrameError(503, "authentication is unavailable")
        progress, report = _progress_channel()
        future = submit_in_context(
            _SYNC_EXECUTOR,
            local.resume_human,
            team_id,
            payload,
            report,
            assurance=assurance,
        )
    except FrameError as exc:
        await _send_event(websocket, _error_terminal(exc.status, exc.detail))
        return
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    connection.sync_terminal_sent = False
    connection.sync_task = asyncio.create_task(
        _deliver_human_response(
            websocket,
            connection,
            team_id,
            future,
            progress,
            authentication_failure,
        )
    )


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
    if connection.active is not None or connection.sync_task is not None or connection.install is not None:
        await _send_event(websocket, _error_terminal(409, "a chat turn is already active"))
        return
    if connection.pending_challenge_id is not None:
        await _send_event(
            websocket,
            _error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return
    had_install_proposal = connection.install_proposal is not None
    if await install_flow.resolve(websocket, connection, team_id, payload, _send_event):
        return
    try:
        progress, report = _progress_channel()
        future = submit_in_context(_TURN_EXECUTOR, local.turn, team_id, payload, report)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    discovery_future = None
    if not had_install_proposal and connection.install_proposal is None:
        discovery_future = install_flow.submit_discovery(team_id, payload)
    turn = _Turn(
        future=future,
        operation="chat",
        language_exemplar=team_contract.canonical_language_exemplar(payload["message"]),
        discovery_future=discovery_future,
        progress=progress,
    )
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


async def _dispatch_stop(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    if connection.sync_task is not None:
        sent = await _send_sync_terminal_once(
            websocket,
            connection,
            _error_terminal(409, "a chat continuation is already active"),
        )
        if sent:
            connection.closed = True
            await websocket.close(code=1008)
            raise WebSocketDisconnect(1008)
        return
    if connection.active is None and connection.pending_challenge_id is None:
        await _send_event(websocket, _error_terminal(409, "no active chat turn"))
        return
    if connection.active is None:
        connection.active = _Turn(future=None, operation="pending-stop")
    _request_stop(websocket, connection, connection.active, team_id, emit=True)


async def _dispatch(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
) -> None:
    frame_type = frame.get("type")
    if connection.install is not None:
        await _send_event(websocket, _error_terminal(409, "an Assistant installation is already active"))
        return
    if connection.install_proposal is not None and frame_type != "chat":
        await _send_event(websocket, _error_terminal(409, "an Assistant install decision is pending"))
        return
    if frame_type == "sync" and set(frame) == {"type"}:
        await _dispatch_sync(websocket, connection, team_id)
    elif frame_type == "chat":
        await _dispatch_chat(websocket, connection, team_id, frame)
    elif frame_type == "stop" and set(frame) == {"type"}:
        await _dispatch_stop(websocket, connection, team_id)
    elif frame_type == "human-response":
        await _dispatch_human_response(websocket, connection, team_id, frame, authenticate)
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


async def _close_connection(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
) -> None:
    connection.closed = True
    sync_task = connection.sync_task
    if sync_task is not None:
        sync_task.cancel()
        await asyncio.gather(sync_task, return_exceptions=True)
    active = connection.active
    if active is not None:
        stop_task = active.stop_task
        if active.future is not None and not active.future.done():
            stop_task = _request_stop(websocket, connection, active, team_id, emit=False)
        if stop_task is not None:
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(
                    asyncio.shield(stop_task),
                    timeout=STOP_RESULT_WAIT_SECONDS,
                )
        if active.delivery is not None:
            active.delivery.cancel()
            await asyncio.gather(active.delivery, return_exceptions=True)
    await install_flow.close(connection)


async def serve(
    websocket: WebSocket,
    team_id: object,
    *,
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    request_scope: Callable[[Mapping[str, str]], contextlib.AbstractContextManager[None]],
    allowed_origins: Callable[[], frozenset[str]],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
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
                await _dispatch(websocket, connection, canonical_id, frame, authenticate)
        except WebSocketDisconnect, RuntimeError, OSError:
            connection.closed = True
        finally:
            await _close_connection(websocket, connection, canonical_id)
