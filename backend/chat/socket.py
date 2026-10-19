"""The chat frames of one Team over the Admin session socket: `shimpz.chat.v7` (ADR-0114).

Provider and Assistant secrets stay behind :mod:`chat.local`; this module dispatches the frames of a Team's run
(:mod:`chat.run`, ADR-0119), admits one mutating operation at a time, keeps Stop responsive on its own bounded worker
lane, and projects controller state onto small, exact public schemas.
"""

import asyncio
import concurrent.futures
import contextlib
import logging
from collections.abc import Awaitable, Callable, Mapping

from chat.connection import Connection, SyncSnapshot, Turn, forget_challenge, remember_challenge, request_identity
from chat.delivery import challenge as challenge_delivery
from chat.delivery import gated
from chat.delivery import plan as plan_delivery
from chat.delivery import progress as progress_transport
from chat.delivery import route as route_delivery
from chat.delivery import sync as sync_delivery
from chat.delivery import terminal as terminal_delivery
from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from chat.projection import error_terminal, first_challenge, integration_challenge_event, stop_accepted, turn_terminal
from fastapi import WebSocket, WebSocketDisconnect
from history import delivery as history_delivery
from history import store as history
from team import transport

from chat import (
    assistant_route,
    human,
    lifecycle,
    local,
    payloads,
    task_resume,
)
from chat import gate as chat_gate
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

STOP_RESULT_WAIT_SECONDS = 15
# Independent bounded worker lanes for chat control operations: a slow provider can never consume the worker needed to
# revoke its Team turn.
TURN_LANE = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=2, thread_name_prefix="shimpz-chat-turn")
STOP_LANE = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=4, thread_name_prefix="shimpz-chat-stop")
SYNC_LANE = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=4, thread_name_prefix="shimpz-chat-sync")
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
    future = submit_in_context(TURN_LANE, local.turn, team_id, payload, turn.conversation, turn.request, report)
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
        if not gated.space_busy(response) or turn.slot is None or turn.stop_requested or connection.closed:
            break
        # Team runs as many turns as the Space's limit, some of them unknown here: this one waits at the head of the
        # queue and asks again, still under a current session (the gate ends it otherwise); Stop meanwhile ends it
        # there (ADR-0119).
        turn.operation = "queued"
        await turn.slot.busy()
        await gated.authorized(websocket)
    await _deliver_turn(websocket, connection, turn, team_id, response)


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
        future = submit_in_context(SYNC_LANE, _sync_snapshot, team_id, locale)
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
            lambda report: submit_in_context(SYNC_LANE, local.resume_integrations, team_id, challenge_id, report),
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
                await gated.authorized(websocket)
                progress, report = _progress_channel()
                try:
                    future = connection.continuation = submit(report)
                except ExecutorSaturatedError:
                    await _send_sync_terminal_once(
                        websocket, connection, error_terminal(429, "local chat capacity reached")
                    )
                    return None
                response = None
                try:
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
                finally:
                    connection.continuation = None
                if not gated.space_busy(response) or connection.closed:
                    return response
                await held.busy()
    except gated.REFUSED as error:
        await _send_sync_terminal_once(websocket, connection, gated.refusal(error))
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
        response = await team_stop(team_id)
        accepted = stop_accepted(response, team_id)
        if accepted is None:
            turn.stop_unconfirmed = stop_status(response)
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
            await _send_terminal_once(websocket, connection, turn, unstopped(turn.stop_unconfirmed))
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


async def team_stop(team_id: str) -> object:
    """Ask Team to stop the Team's chat; Stop has the same fail-closed callback boundary as turn delivery."""
    response: object = transport.TeamResponse(502, {})
    with contextlib.suppress(Exception):
        try:
            response = await asyncio.wrap_future(submit_in_context(STOP_LANE, local.stop, team_id))
        except ExecutorSaturatedError:
            response = transport.TeamResponse(429, {})
    return response


def stop_status(response: object) -> int:
    return response.status if isinstance(response, transport.TeamResponse) else 502


def unstopped(status: int | None) -> dict[str, object]:
    return error_terminal(status or 502, "chat turn could not be stopped")


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
        return submit_in_context(SYNC_LANE, local.resume_human, team_id, payload, report, assurance=assurance)

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


async def dispatch(
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


async def close_connection(
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
