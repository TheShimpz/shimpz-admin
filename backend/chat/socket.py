"""The chat channel of the Admin session socket: `shimpz.chat.v7` for one attached Team (ADR-0114).

Provider and Assistant secrets stay behind :mod:`chat.local`; this module admits one mutating operation per channel,
keeps Stop responsive on its own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

import asyncio
import concurrent.futures
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

import supervisor as local_supervisor
from chat.connection import Connection, SyncSnapshot, Turn, forget_challenge, remember_challenge, request_identity
from chat.delivery import challenge as challenge_delivery
from chat.delivery import gated
from chat.delivery import plan as plan_delivery
from chat.delivery import progress as progress_transport
from chat.delivery import route as route_delivery
from chat.delivery import sync as sync_delivery
from chat.delivery import terminal as terminal_delivery
from chat.executor import ExecutorSaturatedError, submit_in_context
from chat.projection import error_terminal, first_challenge, integration_challenge_event, stop_accepted, turn_terminal
from fastapi import WebSocket, WebSocketDisconnect
from history import delivery as history_delivery
from history import store as history
from signin import auth
from team import transport

from chat import (
    assistant_route,
    human,
    lanes,
    lifecycle,
    local,
    payloads,
    task_resume,
)
from chat import gate as chat_gate
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

STOP_RESULT_WAIT_SECONDS = 15
# The frames one Team's channel may hold while an earlier one dispatches; a page sends one at a time, and Stop.
MAX_WAITING_FRAMES = 8
FrameError = chat_ws_common.FrameError
log = logging.getLogger("shimpz-admin")


_send_terminal_once = terminal_delivery.turn
_send_sync_terminal_once = terminal_delivery.resumed
_send_event = terminal_delivery.send


async def _send_sync_event(
    websocket: WebSocket,
    connection: Connection,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or connection.sync_terminal_sent:
        return False
    if not await _send_event(websocket, event):
        connection.closed = True
        return False
    return True


_SYNC_OPERATIONS = sync_delivery.Operations(
    send_event=_send_sync_event,
    send_terminal=_send_sync_terminal_once,
)


_progress_channel = progress_transport.channel


async def _await_progress_result(
    websocket: WebSocket,
    connection: Connection,
    future: concurrent.futures.Future,
    progress: asyncio.Queue[dict[str, object]],
    inactive: Callable[[], bool],
    record: progress_transport.RecordEvent,
) -> object | None:
    async def send(event: Mapping[str, object]) -> bool:
        if not await _send_event(websocket, event):
            return False
        # The receipt keeps only what the browser received.
        record(event)
        return True

    return await progress_transport.await_result(
        future,
        progress,
        inactive,
        send,
        lambda: setattr(connection, "closed", True),
    )


async def _await_turn_response(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
) -> object:
    if turn.future is None or turn.progress is None:
        return transport.TeamResponse(502, {})
    result = await _await_progress_result(
        websocket,
        connection,
        turn.future,
        turn.progress,
        lambda: connection.closed or turn.terminal_sent,
        progress_transport.receipt_delivery(connection.receipt, turn.history_id, fresh=True),
    )
    return transport.TeamResponse(502, {}) if result is None else result


async def _turn_response(websocket: WebSocket, connection: Connection, turn: Turn) -> object:
    """The Team's answer to the submitted turn, its progress delivered first."""
    response = transport.TeamResponse(502, {})
    # A provider callback may raise any ordinary exception. This process boundary must fail
    # closed while cancellation and process-control BaseExceptions continue to propagate.
    with contextlib.suppress(Exception):
        try:
            if turn.future is not None:
                response = await _await_turn_response(websocket, connection, turn)
        except asyncio.CancelledError:
            raise
        except transport.TeamRequestError:
            response = transport.TeamResponse(400, {})
    return response


async def _deliver_turn(
    websocket: WebSocket, connection: Connection, turn: Turn, team_id: str, response: object
) -> None:
    try:
        if turn.stop_requested and turn.stop_task is not None:
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(
                    asyncio.shield(turn.stop_task),
                    timeout=STOP_RESULT_WAIT_SECONDS,
                )
        # A channel that closed meanwhile stops its turn as it closes (`_close_connection`).
        if connection.closed or turn.terminal_sent:
            return
        challenge, challenge_type = first_challenge(response, team_id)
        if challenge is not None and challenge_type is not None:
            connection.lifecycle_proposal = None
            await challenge_delivery.deliver(
                websocket,
                connection,
                turn,
                team_id,
                challenge,
                challenge_type,
                challenge_delivery.Operations(
                    send_event=_send_event,
                    send_terminal=_send_terminal_once,
                ),
            )
            return
        if isinstance(response, transport.TeamResponse) and (
            response.status == 428
            or (
                isinstance(response.body, dict)
                and response.body.get("status") in {"human-required", "integrations-required"}
            )
        ):
            event = error_terminal(502, "the Assistant challenge was invalid")
        else:
            event = turn_terminal(response, team_id)
        if event.get("type") == "done":
            forget_challenge(connection)
        await _send_terminal_once(websocket, connection, turn, event)
    finally:
        if connection.active is turn:
            connection.active = None


def _submit_team_turn(
    team_id: str,
    payload: dict[str, object],
    turn: Turn,
) -> tuple[concurrent.futures.Future, asyncio.Queue[dict[str, object]]]:
    progress, report = _progress_channel()
    future = submit_in_context(lanes.TURN, local.turn, team_id, payload, turn.conversation, turn.request, report)
    return future, progress


async def _continue_team_turn(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    payload: dict[str, object],
) -> None:
    if turn.stop_requested or connection.closed:
        await _finish_active_turn(websocket, connection, turn, {"type": "stopped"})
        return
    while True:
        try:
            future, progress = _submit_team_turn(team_id, payload, turn)
        except ExecutorSaturatedError:
            await _finish_active_turn(websocket, connection, turn, error_terminal(429, "local chat capacity reached"))
            return
        turn.future = future
        turn.progress = progress
        turn.operation = "chat"
        turn.lifecycle_stop = None
        response = await _turn_response(websocket, connection, turn)
        if not _space_busy(response, turn, connection):
            break
        # Team runs as many turns as the Space's limit, some of them unknown here: this one waits at the head of the
        # queue and asks again; Stop meanwhile ends it there (ADR-0119).
        turn.operation = "queued"
        await turn.slot.busy()
    await _deliver_turn(websocket, connection, turn, team_id, response)


def _space_busy(response: object, turn: Turn, connection: Connection) -> bool:
    """Whether Team refused the turn only because the Space runs as many chat turns as its limit, and it may wait."""
    return (
        isinstance(response, transport.TeamResponse)
        and response.status == 429
        and response.body == {"code": "space-busy"}
        and turn.slot is not None
        and not turn.stop_requested
        and not connection.closed
    )


async def _finish_active_turn(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    event: Mapping[str, object],
) -> None:
    await _send_terminal_once(websocket, connection, turn, event)
    if connection.active is turn:
        connection.active = None


def _sync_snapshot(team_id: str, locale: str) -> SyncSnapshot:
    pending_integration = local.pending_integrations(team_id)
    integration_challenge = integration_challenge_event(pending_integration, team_id)
    if integration_challenge is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn, which resumes under the
        # Space's chat gate (ADR-0119).
        return SyncSnapshot("integration", pending_integration, resume=integration_challenge["challenge_id"])
    if not sync_delivery.is_empty_pending(pending_integration, team_id):
        return SyncSnapshot("integration", pending_integration)
    # A pending human request is restored in the interface language the browser selected (ADR-0091).
    return SyncSnapshot("human", local.open_human(team_id, locale))


async def _load_sync_snapshot(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    locale: str,
) -> SyncSnapshot | None:
    try:
        future = submit_in_context(lanes.SYNC, _sync_snapshot, team_id, locale)
    except ExecutorSaturatedError:
        await _send_sync_terminal_once(
            websocket,
            connection,
            error_terminal(429, "local chat capacity reached"),
        )
        return None
    snapshot = None
    with contextlib.suppress(Exception):
        snapshot = await asyncio.wrap_future(future)
    if isinstance(snapshot, SyncSnapshot) and snapshot.resume is not None:
        challenge_id = snapshot.resume
        resumed = await _gated_continuation(
            websocket,
            connection,
            lambda report: submit_in_context(lanes.SYNC, local.resume_integrations, team_id, challenge_id, report),
        )
        snapshot = None if resumed is None else SyncSnapshot("integration", snapshot.pending, resumed)
    if snapshot is None and not connection.closed:
        await _send_sync_terminal_once(websocket, connection, error_terminal(502))
    return snapshot


async def _gated_continuation(
    websocket: WebSocket,
    connection: Connection,
    submit: Callable[[Callable[[dict[str, object]], None]], concurrent.futures.Future],
) -> object | None:
    """Run one continuation of a paused turn under a slot of the Space's chat gate (ADR-0119).

    Team's answer that the Space is busy puts it back at the head of the queue and asks again; None means it ended
    without a result, its terminal sent when it had one to send.
    """
    try:
        async with chat_gate.GATE.slot(gated.position(websocket), gated.read_limit) as held:
            while True:
                progress, report = _progress_channel()
                try:
                    future = submit(report)
                except ExecutorSaturatedError:
                    await _send_sync_terminal_once(
                        websocket, connection, error_terminal(429, "local chat capacity reached")
                    )
                    return None
                response = None
                with contextlib.suppress(Exception):
                    response = await _await_progress_result(
                        websocket,
                        connection,
                        future,
                        progress,
                        lambda: connection.closed or connection.sync_terminal_sent,
                        progress_transport.receipt_delivery(
                            connection.receipt, connection.pending_history_id, fresh=False
                        ),
                    )
                busy = (
                    isinstance(response, transport.TeamResponse)
                    and response.status == 429
                    and response.body == {"code": "space-busy"}
                )
                if not busy or connection.closed:
                    return response
                await held.busy()
    except chat_gate.QueueFullError:
        await _send_sync_terminal_once(websocket, connection, error_terminal(429, "the chat queue is full"))
    except gated.LimitUnavailableError:
        await _send_sync_terminal_once(
            websocket, connection, error_terminal(503, "the Space chat limit is unavailable")
        )
    return None


async def _deliver_sync(websocket: WebSocket, connection: Connection, team_id: str, locale: str) -> None:
    task = asyncio.current_task()
    try:
        completed = False
        with contextlib.suppress(Exception):
            connection.pending_history_id = await history_delivery.observe(team_id)
            snapshot = await _load_sync_snapshot(websocket, connection, team_id, locale)
            if snapshot is None:
                return
            if connection.closed:
                return
            if snapshot.challenge_type == "human":
                await sync_delivery.human(
                    websocket,
                    connection,
                    team_id,
                    snapshot.pending,
                    _SYNC_OPERATIONS,
                )
            else:
                await sync_delivery.integration(
                    websocket,
                    connection,
                    team_id,
                    snapshot.pending,
                    snapshot.resumed,
                    _SYNC_OPERATIONS,
                )
            completed = True
        if (
            not completed
            and not connection.closed
            and not connection.sync_terminal_sent
            and not await _send_sync_terminal_once(
                websocket,
                connection,
                error_terminal(502),
            )
        ):
            connection.closed = True
    finally:
        if connection.sync_task is task:
            connection.sync_task = None


async def _run_stop(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    *,
    emit: bool,
) -> None:
    try:
        response = transport.TeamResponse(502, {})
        # Stop has the same fail-closed callback boundary as turn delivery.
        with contextlib.suppress(Exception):
            try:
                response = await asyncio.wrap_future(submit_in_context(lanes.STOP, local.stop, team_id))
            except ExecutorSaturatedError:
                response = transport.TeamResponse(429, {})
        accepted = stop_accepted(response, team_id)
        if not emit or connection.closed or turn.terminal_sent:
            return
        if accepted is True:
            forget_challenge(connection)
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                {"type": "stopped"},
                finish_history=True,
            )
        elif accepted is None:
            status = response.status if isinstance(response, transport.TeamResponse) else 502
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                error_terminal(status, "chat turn could not be stopped"),
            )
        elif turn.operation == "pending-stop":
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                error_terminal(409, "no active chat turn"),
                finish_history=True,
            )
        # ``False`` races safely with a turn that has already finished; its normal terminal wins.
    finally:
        turn.stop_task = None
        if turn.operation == "pending-stop" and turn.terminal_sent and connection.active is turn:
            connection.active = None


async def _finish_cancelled_turn(websocket: WebSocket, connection: Connection, turn: Turn) -> None:
    try:
        await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
    finally:
        if connection.active is turn:
            connection.active = None


def _request_stop(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    team_id: str,
    *,
    emit: bool,
) -> asyncio.Task | None:
    if turn.stop_requested:
        return turn.stop_task
    turn.stop_requested = True
    if turn.operation == "queued":
        # Nothing of it runs while it waits for the gate: it leaves the queue at once.
        if turn.delivery is not None:
            turn.delivery.cancel()
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_finish_cancelled_turn(websocket, connection, turn))
        return turn.stop_task
    if turn.lifecycle_stop is not None:
        turn.lifecycle_stop.set()
        if turn.operation == "assistant-plan":
            return None
        if turn.future is not None:
            turn.future.cancel()
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_finish_cancelled_turn(websocket, connection, turn))
        return turn.stop_task
    cancelled = turn.future is not None and turn.future.cancel()
    if cancelled and connection.pending_challenge_id is None:
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_finish_cancelled_turn(websocket, connection, turn))
        return turn.stop_task
    turn.stop_task = asyncio.create_task(_run_stop(websocket, connection, turn, team_id, emit=emit))
    return turn.stop_task


async def _dispatch_sync(websocket: WebSocket, connection: Connection, team_id: str, locale: str) -> None:
    if connection.sync_task is not None or connection.active is not None:
        await _send_event(websocket, error_terminal(409, "a chat operation is already active"))
        return
    connection.sync_terminal_sent = False
    connection.sync_task = asyncio.create_task(_deliver_sync(websocket, connection, team_id, locale))


def _authenticated_denial(response: object) -> bool:
    return (
        isinstance(response, local.PublicResponse)
        and response.status == 409
        and response.body == {"code": "human-request-denied"}
    )


async def _deliver_human_response(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    submit: Callable[[Callable[[dict[str, object]], None]], concurrent.futures.Future],
    authentication_failure: tuple[int, str] | None,
) -> None:
    task = asyncio.current_task()
    try:
        response = await _gated_continuation(websocket, connection, submit)
        if response is None or connection.closed:
            if not connection.closed:
                await _send_sync_terminal_once(websocket, connection, error_terminal(502))
            return
        if authentication_failure is not None:
            confirmed = _authenticated_denial(response)
            event = error_terminal(*authentication_failure) if confirmed else turn_terminal(response, team_id)
            if event.get("type") == "done":
                confirmed = True
            if confirmed:
                forget_challenge(connection)
            await _send_sync_terminal_once(
                websocket,
                connection,
                event,
                finish_history=confirmed,
            )
            return
        challenge, challenge_type = first_challenge(response, team_id)
        if challenge is not None and challenge_type is not None:
            remember_challenge(connection, challenge, challenge_type)
            await _send_sync_event(websocket, connection, challenge)
            return
        event = turn_terminal(response, team_id)
        confirmed = event.get("type") == "done"
        if confirmed:
            forget_challenge(connection)
        await _send_sync_terminal_once(websocket, connection, event, finish_history=confirmed)
    finally:
        if connection.sync_task is task:
            connection.sync_task = None


async def _dispatch_human_response(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
) -> None:
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, error_terminal(409, "a chat operation is already active"))
        return
    request = connection.pending_human_request
    if (
        connection.pending_challenge_type != "human"
        or connection.pending_challenge_id != frame.get("challenge_id")
        or request is None
    ):
        await _send_event(websocket, error_terminal(409, "the human challenge is not pending"))
        return
    try:
        payload, assurance, rejection, authentication_failure = await human.response_payload(
            frame,
            request,
            authenticate,
        )
        if rejection is not None:
            if not await _send_event(websocket, rejection):
                connection.closed = True
            return
        if payload is None:
            raise FrameError(503, "authentication is unavailable")
    except FrameError as exc:
        await _send_event(websocket, error_terminal(exc.status, exc.detail))
        return

    def submit(report: Callable[[dict[str, object]], None]) -> concurrent.futures.Future:
        return submit_in_context(lanes.SYNC, local.resume_human, team_id, payload, report, assurance=assurance)

    connection.sync_terminal_sent = False
    connection.sync_task = asyncio.create_task(
        _deliver_human_response(websocket, connection, team_id, submit, authentication_failure)
    )


async def _admit_chat_payload(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
) -> tuple[dict[str, object], dict[str, object]] | None:
    """The admitted chat payload and the identity of its logical send, or None after an error terminal."""
    if set(frame) != {"type", *payloads.CHAT_PAYLOAD_FIELDS}:
        await _send_event(
            websocket,
            error_terminal(400, "chat frame requires message, files, assistant_ids, locale, and timezone"),
        )
        return None
    try:
        payload = payloads.canonical_chat_payload({key: frame[key] for key in payloads.CHAT_PAYLOAD_FIELDS})
    except transport.TeamRequestError:
        payload = None
    if payload is None:
        await _send_event(websocket, error_terminal(400, "invalid chat request"))
        return None
    if connection.active is not None or connection.sync_task is not None or connection.lifecycle is not None:
        await _send_event(websocket, error_terminal(409, "a chat turn is already active"))
        return None
    if connection.pending_challenge_id is not None:
        await _send_event(
            websocket,
            error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return None
    identity = request_identity()
    admitted = lifecycle.reuses_history(connection, payload) or await _commit_user_history(
        websocket,
        connection,
        team_id,
        payload,
    )
    return (payload, identity) if admitted else None


async def _commit_user_history(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    payload: dict[str, object],
) -> bool:
    try:
        history_id = await history_delivery.admit(team_id, payload["message"], files=payload["files"])
    except ExecutorSaturatedError:
        await _send_event(websocket, error_terminal(429, "Admin chat history capacity reached"))
        return False
    except history_delivery.SelectedFileUnavailableError:
        await _send_event(websocket, error_terminal(404, "selected file not found"))
        return False
    except history.HistoryUnavailableError, ValueError:
        log.exception("Admin chat user history commit failed")
        await _send_event(websocket, error_terminal(503, "Admin chat history is unavailable"))
        return False
    connection.admitted_history_id = history_id
    return True


def _plan_operations() -> plan_delivery.Operations:
    """The socket's own delivery operations, read when a turn starts."""
    return plan_delivery.Operations(
        send_event=_send_event,
        finish_turn=_finish_active_turn,
        continue_turn=_continue_team_turn,
    )


async def _dispatch_chat(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
) -> None:
    admitted = await _admit_chat_payload(websocket, connection, team_id, frame)
    if admitted is None:
        return
    payload, identity = admitted
    if await lifecycle.resolve(websocket, connection, team_id, payload, _send_event):
        return
    try:
        conversation = await history_delivery.conversation(team_id, connection.admitted_history_id)
    except history.HistoryUnavailableError, ValueError:
        log.exception("Admin chat conversation context projection failed")
        await _send_event(websocket, error_terminal(503, "Admin chat history is unavailable"))
        return
    route_context = assistant_route.Context(
        reference=connection.assistant_reference,
        conversation=conversation,
    )
    turn = route_delivery.begin(connection, None, payload["locale"], conversation, identity)
    turn.operation = "queued"

    async def route() -> None:
        try:
            turn.future = lifecycle.submit_route(team_id, payload, route_context)
        except ExecutorSaturatedError:
            await _finish_active_turn(
                websocket, connection, turn, error_terminal(429, "Assistant routing capacity reached")
            )
            return
        turn.operation = "assistant-route"
        await route_delivery.deliver(websocket, connection, turn, team_id, payload, _plan_operations())

    turn.delivery = asyncio.create_task(gated.run(websocket, connection, turn, route, _finish_active_turn))


async def _dispatch_stop(websocket: WebSocket, connection: Connection, team_id: str) -> None:
    if connection.sync_task is not None:
        sent = await _send_sync_terminal_once(
            websocket,
            connection,
            error_terminal(409, "a chat continuation is already active"),
        )
        if sent:
            connection.closed = True
            await websocket.close(code=1008)
            raise WebSocketDisconnect(1008)
        return
    if connection.active is None:
        history_id = connection.pending_history_id
        if history_id is None:
            try:
                history_id = await history_delivery.resume(team_id)
            except history.HistoryUnavailableError, ValueError:
                await _send_event(
                    websocket,
                    error_terminal(503, "Admin chat history is unavailable"),
                )
                return
        connection.active = Turn(
            future=None,
            operation="pending-stop",
            history_id=history_id,
        )
    _request_stop(websocket, connection, connection.active, team_id, emit=True)


async def _dispatch(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    frame: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
) -> None:
    frame_type = frame.get("type")
    if (
        frame == {"type": "stop"}
        and connection.sync_task is None
        and connection.active is None
        and connection.pending_challenge_id is None
    ):
        # Nothing runs that a Stop ends: it crossed its turn's terminal (a reply, guidance, or an uninstall proposal),
        # or an approved uninstall that ends with its own result. That turn already ended exactly once.
        return
    if connection.lifecycle is not None:
        await _send_event(websocket, error_terminal(409, "an Assistant lifecycle operation is already active"))
        return
    if connection.lifecycle_proposal is not None and frame_type != "chat":
        await _send_event(websocket, error_terminal(409, "an Assistant lifecycle decision is pending"))
        return
    sync_locale = _sync_locale(frame) if frame_type == "sync" else None
    if sync_locale is not None:
        await _dispatch_sync(websocket, connection, team_id, sync_locale)
    elif frame_type == "chat":
        await _dispatch_chat(websocket, connection, team_id, frame)
    elif frame_type == "resume-task":
        await task_resume.dispatch(websocket, connection, team_id, frame, _plan_operations())
    elif frame_type == "stop" and set(frame) == {"type"}:
        await _dispatch_stop(websocket, connection, team_id)
    elif frame_type == "human-response":
        await _dispatch_human_response(websocket, connection, team_id, frame, authenticate)
    else:
        await _send_event(websocket, error_terminal(400, "unsupported chat frame"))


def _sync_locale(frame: dict[str, object]) -> str | None:
    """A sync frame is exactly ``{"type": "sync", "locale": code}``: a restored request renders in that language."""
    return team_contract.canonical_locale(frame["locale"]) if set(frame) == {"type", "locale"} else None


async def _close_connection(
    websocket: WebSocket,
    connection: Connection,
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
    await lifecycle.close(connection)


class Transport:
    """One attached page's view of a Team's chat run: the session socket's frames of that Team.

    The session socket's `send` adds the Team's `team_id` to every frame; `close` ends the whole session socket.
    """

    def __init__(self, send: Callable[[dict[str, object]], None], close: Callable[[int], None]) -> None:
        self._send = send
        self._close = close

    def push(self, event: dict[str, object]) -> None:
        """Queue one event now; it raises when the page's socket can take no more."""
        self._send(event)

    def close(self, code: int = 1000) -> None:
        self._close(code)


@dataclass(frozen=True, slots=True)
class Authority:
    """The Supervisor authority one chat frame was admitted under, held in memory only (ADR-0119).

    `current` checks it again without its socket: the same Origin still admitted and the same session still current by
    the full rule (signature, absolute and idle expiry, rotation, suspension), never renewing it.
    """

    session: str
    scope: Callable[[], contextlib.AbstractContextManager[None]]
    current: Callable[[], Awaitable[bool]]
    authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]]


class Relay(gated.Observed):
    """What a run's delivery code writes to: every event goes to each page attached now, or to none.

    A page that cannot take an event is detached; nothing a page does ends the run's work.
    """

    def __init__(self, run: Run) -> None:
        self.run = run

    async def send_json(self, event: dict[str, object]) -> None:
        self.run.publish(event)

    async def close(self, code: int = 1000) -> None:
        for observer in tuple(self.run.observers):
            observer.close(code)


class Run:
    """One Team's chat in Admin: its state, its frames in arrival order, and the pages that watch it (ADR-0119).

    It outlives every page: a page attaches to watch and detaches without stopping anything; only Stop, a revoked
    authority, the Team's deletion, or a Space reset ends its work. Frames run one at a time, each under the authority
    it was admitted with, checked again when its turn comes, so a long dispatch never holds any page's receive loop.
    """

    def __init__(self, team_id: str) -> None:
        self.team_id = team_id
        self.connection = Connection(team_id=team_id)
        self.relay = Relay(self)
        self.observers: set[Transport] = set()
        # The authority of the operation the run does now, which a revocation of its session ends.
        self.authority: Authority | None = None
        # The progress frames of the running delivery, in order, and when its operation started: a page that attaches
        # meanwhile is shown both, and the queue position while it waits.
        self.live: list[dict[str, object]] = []
        self.started: float | None = None
        self.position: int | None = None
        self._frames: asyncio.Queue[tuple[dict[str, object], Authority]] = asyncio.Queue()
        self._task = asyncio.create_task(self._loop())

    # Pages

    def attach(self, observer: Transport, authority: Authority, locale: str) -> None:
        """Let one more page watch; a busy run shows it where it is, an idle one synchronizes as a fresh page does."""
        self.observers.add(observer)
        if self.busy():
            self._push(observer, self.snapshot())
        else:
            self.submit({"type": "sync", "locale": locale}, authority)

    def detach(self, observer: Transport) -> None:
        """One page stops watching; a proposal that waited for a page's decision expires with the last one."""
        self.observers.discard(observer)
        if not self.observers:
            self.connection.lifecycle_proposal = None
            if not self.busy():
                self.retire()

    def busy(self) -> bool:
        connection = self.connection
        return (
            connection.active is not None
            or connection.sync_task is not None
            or connection.lifecycle is not None
            or not self._frames.empty()
        )

    def snapshot(self) -> dict[str, object]:
        """Where the run is now, as one `running` event: how long it has run, its queue place, and its steps so far."""
        elapsed = 0 if self.started is None else int((time.monotonic() - self.started) * 1000)
        return {"type": "running", "elapsed_ms": max(0, elapsed), "position": self.position, "events": list(self.live)}

    def publish(self, event: dict[str, object]) -> None:
        """Record what a page attaching later must see, then hand the event to every page attached now."""
        kind = event.get("type")
        if kind == "progress":
            if event.get("seq") == 1:
                self.live = []
            if len(self.live) <= local.MAX_PUBLIC_PROGRESS_EVENTS:
                self.live.append(dict(event))
        elif kind == "running":
            position = event.get("position")
            self.position = position if isinstance(position, int) else None
        for observer in tuple(self.observers):
            self._push(observer, event)

    def _push(self, observer: Transport, event: dict[str, object]) -> None:
        try:
            observer.push(dict(event))
        except RuntimeError, ValueError, OSError:
            # An overflowing or closed socket, or a frame it cannot carry: that page stops watching.
            self.observers.discard(observer)

    # Frames

    def submit(self, frame: dict[str, object], authority: Authority) -> bool:
        """Queue one admitted chat frame with the authority it was admitted under; refuse one beyond the bound."""
        if self.connection.closed:
            return True
        if self._frames.qsize() >= MAX_WAITING_FRAMES:
            return False
        self._frames.put_nowait((frame, authority))
        return True

    async def _loop(self) -> None:
        try:
            while True:
                frame, authority = await self._frames.get()
                if not await authority.current():
                    # Its session or Origin ended before its turn came: it runs nothing.
                    continue
                if frame.get("type") != "stop":
                    self.authority = authority
                if frame.get("type") in {"chat", "resume-task", "human-response", "sync"}:
                    self.live, self.started, self.position = [], time.monotonic(), None
                try:
                    with authority.scope():
                        await _dispatch(self.relay, self.connection, self.team_id, frame, authority.authenticate)
                except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
                    # The current Supervisor authority is unavailable: the frame is refused as the HTTP gate refuses.
                    log.warning("chat run frame refused: Supervisor authority is unavailable")
                    self.publish(error_terminal(503, "Supervisor authority is unavailable"))
        except WebSocketDisconnect:
            # A protocol refusal closed the pages; the run's work ends with them, as Stop would end it.
            asyncio.get_running_loop().create_task(self.end())

    # Ending

    def retire(self) -> None:
        """Forget an idle run nobody watches; Team keeps any pending request, which a page's sync restores."""
        if RUNS.get(self.team_id) is self:
            del RUNS[self.team_id]
        self._task.cancel()

    async def end(self) -> None:
        """Stop the run's work, keep how its turn ended, and forget the run (revocation, deletion, reset)."""
        if RUNS.get(self.team_id) is self:
            del RUNS[self.team_id]
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        active = self.connection.active
        unfinished = None if active is None or active.terminal_sent else active.history_id
        authority = self.authority
        try:
            with authority.scope() if authority is not None else contextlib.nullcontext():
                await _close_connection(self.relay, self.connection, self.team_id)
        except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
            log.warning("chat run ended without Supervisor authority")
            await _close_connection(self.relay, self.connection, self.team_id)
        if unfinished is not None:
            with contextlib.suppress(Exception):
                await history_delivery.terminal(self.team_id, unfinished, {"type": "stopped"}, finish_history=True)
            self.publish({"type": "stopped"})


# Each Team's chat run in this Admin process (ADR-0119): an Admin restart ends them all, never replaying any.
RUNS: dict[str, Run] = {}
# How often a run's authority and idleness are checked again while no page or session event says so.
SWEEP_SECONDS = 30.0


def run_for(team_id: str) -> Run:
    """The Team's run, created on first need."""
    run = RUNS.get(team_id)
    if run is None:
        run = RUNS[team_id] = Run(team_id)
        _start_sweep()
    return run


def end_runs(team_id: str | None = None) -> None:
    """End one Team's run, or every run: its Team was deleted, or the Space reset (on the event loop)."""
    for run in [run for key, run in RUNS.items() if team_id is None or key == team_id]:
        asyncio.get_running_loop().create_task(run.end())


def sessions_ended(sessions: frozenset[str] | None) -> None:
    """Sessions stopped being tracked (any thread): end the work each of them authorized."""
    loop = _SWEEP_LOOP[0]
    if loop is None:
        return
    with contextlib.suppress(RuntimeError):
        loop.call_soon_threadsafe(_end_sessions, sessions)


def _end_sessions(sessions: frozenset[str] | None) -> None:
    for run in tuple(RUNS.values()):
        authority = run.authority
        if run.busy() and authority is not None and (sessions is None or authority.session in sessions):
            asyncio.get_running_loop().create_task(run.end())


_SWEEP_LOOP: list[asyncio.AbstractEventLoop | None] = [None]
_SWEEP_TASK: list[asyncio.Task | None] = [None]


def _start_sweep() -> None:
    loop = asyncio.get_running_loop()
    task = _SWEEP_TASK[0]
    if _SWEEP_LOOP[0] is loop and task is not None and not task.done():
        return
    _SWEEP_LOOP[0] = loop
    _SWEEP_TASK[0] = loop.create_task(_sweep())


async def _sweep() -> None:
    """End work whose authority expired meanwhile, and forget idle runs nobody watches."""
    while RUNS:
        await asyncio.sleep(SWEEP_SECONDS)
        for run in tuple(RUNS.values()):
            authority = run.authority
            if run.busy():
                if authority is not None and not await authority.current():
                    await run.end()
            elif not run.observers:
                run.retire()


class Channel:
    """One page watching one Team's chat run over its session socket (ADR-0114, ADR-0119).

    Its frames run on the run under the authority they were admitted with; closing it stops watching, never the work.
    """

    def __init__(self, transport: Transport, team_id: str, authority: Callable[[], Authority]) -> None:
        self.transport = transport
        self.team_id = team_id
        self._authority = authority
        self.run = run_for(team_id)

    @property
    def connection(self) -> Connection:
        return self.run.connection

    def attach(self, locale: str) -> None:
        self.run.attach(self.transport, self._authority(), locale)

    def submit(self, frame: dict[str, object]) -> bool:
        """Queue one admitted chat frame for the Team's run in arrival order; refuse one beyond the waiting bound."""
        return self.run.submit(frame, self._authority())

    def halt(self) -> None:
        """Stop watching at once: the socket is closing."""
        self.run.detach(self.transport)

    async def close(self) -> None:
        """Stop watching; the run's work goes on (ADR-0119)."""
        self.halt()


auth.SESSIONS.listen(sessions_ended)
