"""The chat channel of the Admin session socket: `shimpz.chat.v7` for one attached Team (ADR-0114).

Provider and Assistant secrets stay behind :mod:`chat.local`; this module admits one mutating operation per channel,
keeps Stop responsive on its own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

import asyncio
import concurrent.futures
import contextlib
import logging
from collections.abc import Awaitable, Callable, Mapping

import supervisor as local_supervisor
from chat.connection import Connection, SyncSnapshot, Turn, forget_challenge, remember_challenge, request_identity
from chat.delivery import challenge as challenge_delivery
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
    error_terminal=error_terminal,
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


async def _deliver_turn(websocket: WebSocket, connection: Connection, turn: Turn, team_id: str) -> None:
    try:
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
                    error_terminal=error_terminal,
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
        await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
        if connection.active is turn:
            connection.active = None
        return
    try:
        future, progress = _submit_team_turn(team_id, payload, turn)
    except ExecutorSaturatedError:
        await _send_terminal_once(websocket, connection, turn, error_terminal(429, "local chat capacity reached"))
        if connection.active is turn:
            connection.active = None
        return
    turn.future = future
    turn.progress = progress
    turn.operation = "chat"
    turn.lifecycle_stop = None
    await _deliver_turn(websocket, connection, turn, team_id)


async def _finish_active_turn(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    event: Mapping[str, object],
) -> None:
    await _send_terminal_once(websocket, connection, turn, event)
    if connection.active is turn:
        connection.active = None


def _sync_snapshot(
    team_id: str,
    locale: str,
    progress: Callable[[dict[str, object]], None],
) -> SyncSnapshot:
    pending_integration = local.pending_integrations(team_id)
    integration_challenge = integration_challenge_event(pending_integration, team_id)
    if integration_challenge is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn.
        resumed = local.resume_integrations(team_id, integration_challenge["challenge_id"], progress)
        return SyncSnapshot("integration", pending_integration, resumed)
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
    progress, report = _progress_channel()
    try:
        future = submit_in_context(lanes.SYNC, _sync_snapshot, team_id, locale, report)
    except ExecutorSaturatedError:
        await _send_sync_terminal_once(
            websocket,
            connection,
            error_terminal(429, "local chat capacity reached"),
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
            progress_transport.receipt_delivery(connection.receipt, connection.pending_history_id, fresh=False),
        )
    if snapshot is None and not connection.closed:
        await _send_sync_terminal_once(websocket, connection, error_terminal(502))
    return snapshot


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
                progress_transport.receipt_delivery(connection.receipt, connection.pending_history_id, fresh=False),
            )
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
        progress, report = _progress_channel()
        future = submit_in_context(
            lanes.SYNC,
            local.resume_human,
            team_id,
            payload,
            report,
            assurance=assurance,
        )
    except FrameError as exc:
        await _send_event(websocket, error_terminal(exc.status, exc.detail))
        return
    except ExecutorSaturatedError:
        await _send_event(websocket, error_terminal(429, "local chat capacity reached"))
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
        error_terminal=error_terminal,
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
    try:
        preparation = lifecycle.submit_route(team_id, payload, route_context)
    except ExecutorSaturatedError:
        await _send_event(websocket, error_terminal(429, "Assistant routing capacity reached"))
        return
    turn = route_delivery.begin(connection, preparation, payload["locale"], conversation, identity)
    turn.delivery = asyncio.create_task(
        route_delivery.deliver(websocket, connection, turn, team_id, payload, _plan_operations())
    )


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
    """One attached Team's chat channel on its session socket, as the `shimpz.chat.v7` delivery code writes to it.

    Every frame sent carries the Team's `team_id`. When the delivery code closes its connection, the whole session
    socket closes.
    """

    def __init__(self, team_id: str, send: Callable[[dict[str, object]], None], close: Callable[[int], None]) -> None:
        self._team_id = team_id
        self._send = send
        self._close = close

    async def send_json(self, event: dict[str, object]) -> None:
        self._send(event)

    async def close(self, code: int = 1000) -> None:
        self._close(code)


class Channel:
    """One Team's logical chat connection on a session socket, with today's per-connection state (ADR-0114).

    Frames run in arrival order, one at a time, under the current Supervisor authority bound again for each frame, so
    a long dispatch never holds the session socket's receive loop. A waiting frame runs only if its socket's bound
    Origin and session are still current when its turn comes; otherwise the socket closes and nothing more runs.
    Closing the channel asks Team to stop its active turn and ends every local operation it runs.
    """

    def __init__(
        self,
        transport: Transport,
        team_id: str,
        *,
        request_scope: Callable[[], contextlib.AbstractContextManager[None]],
        authenticate: Callable[[str, str], Awaitable[human.AuthenticationResult]],
        authorized: Callable[[], Awaitable[bool]],
    ) -> None:
        self.transport = transport
        self.team_id = team_id
        self.connection = Connection()
        self._scope = request_scope
        self._authorized = authorized
        self._authenticate = authenticate
        self._frames: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._task = asyncio.create_task(self._run())

    def submit(self, frame: dict[str, object]) -> bool:
        """Queue one admitted chat frame for this Team in arrival order; refuse one beyond the waiting bound."""
        if self.connection.closed:
            return True
        if self._frames.qsize() >= MAX_WAITING_FRAMES:
            return False
        self._frames.put_nowait(frame)
        return True

    async def _run(self) -> None:
        try:
            while True:
                frame = await self._frames.get()
                if not await self._authorized():
                    # The socket closes for its refused Origin or session: no waiting frame runs any more.
                    self.connection.closed = True
                    return
                try:
                    with self._scope():
                        await _dispatch(self.transport, self.connection, self.team_id, frame, self._authenticate)
                except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
                    # The current Supervisor authority is unavailable: the frame is refused as the HTTP gate refuses.
                    log.warning("chat channel frame refused: Supervisor authority is unavailable")
                    await _send_event(self.transport, error_terminal(503, "Supervisor authority is unavailable"))
        except WebSocketDisconnect:
            self.connection.closed = True

    def halt(self) -> None:
        """Dispatch nothing more, at once: no waiting frame starts once the channel's socket is closing."""
        self.connection.closed = True
        self._task.cancel()

    async def close(self) -> None:
        """Stop the channel: Team stops its active turn and every local operation it runs ends."""
        self.halt()
        await asyncio.gather(self._task, return_exceptions=True)
        try:
            with self._scope():
                await _close_connection(self.transport, self.connection, self.team_id)
        except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
            # Without current authority Team refuses the Stop, but every local operation still ends here.
            log.warning("chat channel closed without Supervisor authority")
            await _close_connection(self.transport, self.connection, self.team_id)
