"""Bounded, session-authenticated WebSocket transport for local Team chat.

The browser speaks only ``shimpz.chat.v3``. Provider and Assistant secrets stay behind
:mod:`localchat`; this module admits one mutating operation per socket, keeps Stop responsive on its
own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

import localchat
import teams
from fastapi import WebSocket, WebSocketDisconnect

CHAT_SUBPROTOCOL = "shimpz.chat.v3"
MAX_FRAME_BYTES = 512 * 1024
MAX_PUBLIC_ERROR_CHARS = 800
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class FrameError(ValueError):
    def __init__(self, status: int, detail: str, close_code: int = 1007) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.close_code = close_code


class ExecutorSaturatedError(RuntimeError):
    """The fixed worker and queue budget has no free admission slot."""


class BoundedExecutor:
    """A ThreadPoolExecutor with non-blocking admission in front of its otherwise unbounded queue."""

    def __init__(self, *, workers: int, outstanding: int, name: str) -> None:
        if workers < 1 or outstanding < workers:
            raise ValueError("invalid bounded executor capacity")
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self._slots = threading.BoundedSemaphore(outstanding)

    def submit(self, function: Callable, /, *args) -> concurrent.futures.Future:
        if not self._slots.acquire(blocking=False):
            raise ExecutorSaturatedError("chat worker capacity reached")
        try:
            future = self._executor.submit(function, *args)
        except BaseException:
            self._slots.release()
            raise
        future.add_done_callback(lambda _completed: self._slots.release())
        return future

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


# Turns and cancellation use separate bounded lanes: a slow provider can never consume the worker
# needed to revoke it. The local controller remains the authoritative per-Team admission boundary.
_TURN_EXECUTOR = BoundedExecutor(workers=2, outstanding=2, name="shimpz-chat-turn")
_STOP_EXECUTOR = BoundedExecutor(workers=2, outstanding=4, name="shimpz-chat-stop")
_SYNC_EXECUTOR = BoundedExecutor(workers=2, outstanding=4, name="shimpz-chat-sync")


def canonical_origin(value: str | None) -> str | None:
    """Return one exact HTTP(S) Origin, preserving an explicitly supplied port."""
    if not value or value == "null":
        return None
    try:
        parsed = urlparse(value)
        _ = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _configured_origins() -> frozenset[str]:
    configured = os.environ.get("SHIMPZ_ADMIN_ALLOWED_ORIGINS", _DEFAULT_ORIGINS)
    return frozenset(origin for item in configured.split(",") if (origin := canonical_origin(item.strip())) is not None)


ALLOWED_ORIGINS = _configured_origins()


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


async def receive_bounded_json(websocket: WebSocket) -> dict[str, object]:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    if message["type"] != "websocket.receive":
        raise FrameError(400, "invalid WebSocket frame")

    text = message.get("text")
    if text is None or message.get("bytes") is not None:
        raise FrameError(415, "WebSocket frame must be text JSON", 1003)
    try:
        encoded = text.encode("utf-8")
    except UnicodeError as exc:
        raise FrameError(400, "WebSocket frame must be UTF-8 JSON") from exc
    if len(encoded) > MAX_FRAME_BYTES:
        raise FrameError(413, "WebSocket frame too large", 1009)
    raw = text

    try:
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_json_constant)
    except json.JSONDecodeError, UnicodeError, ValueError, RecursionError:
        raise FrameError(400, "WebSocket frame must be valid unique-key JSON") from None
    if not isinstance(value, dict):
        raise FrameError(400, "WebSocket JSON must be an object")
    return value


def _safe_status(value: object, fallback: int = 502) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599 else fallback


def _error_terminal(status: object, detail: str = "local chat request failed") -> dict[str, object]:
    safe_detail = (
        detail
        if 0 < len(detail) <= MAX_PUBLIC_ERROR_CHARS and _CONTROL_RE.search(detail) is None
        else "local chat request failed"
    )
    return {"type": "error", "status": _safe_status(status), "detail": safe_detail}


def _projected_event(
    response: object,
    team_id: str,
    allowed_types: frozenset[str],
) -> dict[str, object] | None:
    if not isinstance(response, localchat.PublicResponse):
        return None
    event = response.websocket_event(team_id)
    if event is None or event.get("type") not in allowed_types:
        return None
    return dict(event)


def turn_terminal(response: object, team_id: str) -> dict[str, object]:
    event = _projected_event(response, team_id, frozenset({"done", "error"}))
    return event if event is not None else _error_terminal(502, "local chat returned an invalid response")


def secret_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"secrets-required"}))


def approval_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"approval-required"}))


def input_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"input-required"}))


def account_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"accounts-required"}))


def secret_inventory_event(response: object, team_id: str) -> dict[str, object] | None:
    return _projected_event(response, team_id, frozenset({"secret-inventory"}))


_CHALLENGE_PROJECTORS = (
    ("account", account_challenge_event),
    ("secret", secret_challenge_event),
    ("input", input_challenge_event),
    ("approval", approval_challenge_event),
)


def _first_challenge(response: object, team_id: str) -> tuple[dict[str, object] | None, str | None]:
    for challenge_type, projector in _CHALLENGE_PROJECTORS:
        if (challenge := projector(response, team_id)) is not None:
            return challenge, challenge_type
    return None, None


def _stop_accepted(response: object, team_id: str) -> bool | None:
    if not isinstance(response, localchat.PublicResponse) or not 200 <= response.status < 300:
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


@dataclass(frozen=True, slots=True)
class _Submission:
    operation: str
    fields: frozenset[str]
    required_message: str
    canonicalize: Callable[[object], dict[str, object]]
    submit_name: str
    challenge_type: str
    missing_message: str
    other_pending_message: str
    stale_message: str


_SUBMISSIONS = {
    "secret-submit": _Submission(
        "secret-submit",
        frozenset({"type", "challenge_id", "values"}),
        "secret-submit frame requires challenge_id and values",
        teams.canonical_secret_submission,
        "submit_secrets",
        "secret",
        "no Assistant secret challenge is pending",
        "an Assistant approval is pending",
        "the Assistant secret challenge is stale",
    ),
    "approval-submit": _Submission(
        "approval-submit",
        frozenset({"type", "challenge_id", "approved"}),
        "approval-submit requires challenge_id and approved",
        teams.canonical_approval_submission,
        "submit_approval",
        "approval",
        "no Assistant approval is pending",
        "Assistant secrets are required",
        "the Assistant approval challenge is stale",
    ),
    "input-submit": _Submission(
        "input-submit",
        frozenset({"type", "challenge_id", "answer"}),
        "input-submit requires challenge_id and answer",
        teams.canonical_input_submission,
        "submit_input",
        "input",
        "no Assistant input is pending",
        "another Assistant challenge is pending",
        "the Assistant input challenge is stale",
    ),
}


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
        response = teams.DriverResponse(502, {})
        # A provider callback may raise any ordinary exception. This process boundary must fail
        # closed while cancellation and process-control BaseExceptions continue to propagate.
        with contextlib.suppress(Exception):
            try:
                if turn.future is not None:
                    response = await asyncio.wrap_future(turn.future)
            except asyncio.CancelledError:
                raise
            except teams.TeamRequestError:
                response = teams.DriverResponse(400, {})
        if connection.closed or turn.stop_requested or turn.terminal_sent:
            return
        challenge, challenge_type = _first_challenge(response, team_id)
        if challenge is not None:
            connection.pending_challenge_id = challenge["challenge_id"]
            connection.pending_challenge_type = challenge_type
            if not await _send_event(websocket, challenge):
                connection.closed = True
            return
        if isinstance(response, teams.DriverResponse) and (
            response.status == 428
            or (
                isinstance(response.body, dict)
                and response.body.get("status")
                in {"accounts-required", "secrets-required", "input-required", "approval-required"}
            )
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


def _sync_snapshot(team_id: str) -> tuple[object, object, object | None, object | None, object | None, object | None]:
    inventory = localchat.secret_inventory(team_id)
    pending_account = localchat.pending_accounts(team_id)
    account_challenge = account_challenge_event(pending_account, team_id)
    if account_challenge is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn.
        resumed = localchat.resume_accounts(team_id, account_challenge["challenge_id"])
        return inventory, pending_account, resumed, None, None, None
    if not _is_empty_pending(pending_account, team_id):
        return inventory, pending_account, None, None, None, None
    return (
        inventory,
        pending_account,
        None,
        localchat.pending_secrets(team_id),
        localchat.pending_input(team_id),
        localchat.pending_approval(team_id),
    )


def _is_empty_pending(response: object, team_id: str) -> bool:
    return (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and response.body == {"team_id": team_id, "status": "none"}
    )


def _pending_error(response: object, team_id: str, challenge_type: str) -> dict[str, object]:
    if (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and not 200 <= response.status < 300
    ):
        return turn_terminal(response, team_id)
    return _error_terminal(502, f"the Assistant {challenge_type} challenge was invalid")


def _select_synced_challenge(
    team_id: str,
    secret_response: object,
    input_response: object,
    approval_response: object,
) -> tuple[dict[str, object] | None, str | None, dict[str, object] | None]:
    candidates: list[tuple[dict[str, object], str]] = []
    for response, projector, challenge_type in (
        (secret_response, secret_challenge_event, "secret"),
        (input_response, input_challenge_event, "input"),
        (approval_response, approval_challenge_event, "approval"),
    ):
        challenge = projector(response, team_id)
        if challenge is not None:
            candidates.append((challenge, challenge_type))
        elif not _is_empty_pending(response, team_id):
            return None, None, _pending_error(response, team_id, challenge_type)
    if len(candidates) > 1:
        return None, None, _error_terminal(502, "conflicting Assistant challenges")
    if not candidates:
        return None, None, None
    challenge, challenge_type = candidates[0]
    return challenge, challenge_type, None


async def _deliver_account_sync(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    pending_response: object,
    resumed_response: object,
) -> bool:
    """Deliver an explicitly resumed account gate; return whether it consumed sync."""
    pending = account_challenge_event(pending_response, team_id)
    if pending is None:
        if _is_empty_pending(pending_response, team_id):
            return False
        await _send_event(websocket, _pending_error(pending_response, team_id, "account"))
        return True
    if resumed_response is None:
        await _send_event(websocket, _error_terminal(502, "the Assistant account challenge was invalid"))
        return True

    resumed, challenge_type = _first_challenge(resumed_response, team_id)
    if resumed is not None:
        pending_turn_id = pending_response.body.get("turn_id")
        resumed_turn_id = resumed_response.body.get("turn_id")
        if pending_turn_id != resumed_turn_id:
            await _send_event(websocket, _error_terminal(502, "the Assistant account challenge was invalid"))
            return True
        connection.pending_challenge_id = resumed["challenge_id"]
        connection.pending_challenge_type = challenge_type
        if not await _send_event(websocket, resumed):
            connection.closed = True
        return True

    if isinstance(resumed_response, teams.DriverResponse) and (
        resumed_response.status == 428
        or (
            isinstance(resumed_response.body, dict)
            and resumed_response.body.get("status")
            in {"accounts-required", "secrets-required", "input-required", "approval-required"}
        )
    ):
        event = _error_terminal(502, "the Assistant account challenge was invalid")
    else:
        event = turn_terminal(resumed_response, team_id)
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    await _send_event(websocket, event)
    return True


async def _deliver_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    task = asyncio.current_task()
    try:
        snapshot: tuple[object, object, object | None, object | None, object | None, object | None] | None = None
        try:
            future = _SYNC_EXECUTOR.submit(_sync_snapshot, team_id)
        except ExecutorSaturatedError:
            await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
            return
        with contextlib.suppress(Exception):
            snapshot = await asyncio.wrap_future(future)
        if snapshot is None:
            await _send_event(websocket, _error_terminal(502))
            return
        (
            inventory_response,
            pending_account_response,
            resumed_account_response,
            pending_response,
            pending_input_response,
            pending_approval_response,
        ) = snapshot
        if connection.closed:
            return

        inventory = secret_inventory_event(inventory_response, team_id)
        if inventory is None:
            if (
                isinstance(inventory_response, teams.DriverResponse)
                and isinstance(inventory_response.status, int)
                and not isinstance(inventory_response.status, bool)
                and not 200 <= inventory_response.status < 300
            ):
                event = turn_terminal(inventory_response, team_id)
            else:
                event = _error_terminal(502, "the Assistant secret inventory was invalid")
            await _send_event(websocket, event)
            return
        if not await _send_event(websocket, inventory):
            connection.closed = True
            return

        if await _deliver_account_sync(
            websocket,
            connection,
            team_id,
            pending_account_response,
            resumed_account_response,
        ):
            return

        challenge, challenge_type, error = _select_synced_challenge(
            team_id,
            pending_response,
            pending_input_response,
            pending_approval_response,
        )
        if error is not None:
            await _send_event(websocket, error)
            return
        if challenge is None:
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
            return
        connection.pending_challenge_id = challenge["challenge_id"]
        connection.pending_challenge_type = challenge_type
        if not await _send_event(websocket, challenge):
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
        response = teams.DriverResponse(502, {})
        # Stop has the same fail-closed callback boundary as turn delivery.
        with contextlib.suppress(Exception):
            try:
                response = await asyncio.wrap_future(_STOP_EXECUTOR.submit(localchat.stop, team_id))
            except ExecutorSaturatedError:
                response = teams.DriverResponse(429, {})
        accepted = _stop_accepted(response, team_id)
        if not emit or connection.closed or turn.terminal_sent:
            return
        if accepted is True:
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
            await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
        elif accepted is None:
            status = response.status if isinstance(response, teams.DriverResponse) else 502
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
        payload = teams.canonical_chat_payload({key: value for key, value in frame.items() if key != "type"})
    except teams.TeamRequestError:
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
        future = _TURN_EXECUTOR.submit(localchat.turn, team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation="chat")
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


def _prepare_submission(
    connection: _Connection,
    frame: dict[str, object],
    submission: _Submission,
) -> dict[str, object]:
    if set(frame) != submission.fields:
        raise FrameError(400, submission.required_message)
    try:
        payload = submission.canonicalize({key: value for key, value in frame.items() if key != "type"})
    except teams.TeamRequestError as exc:
        raise FrameError(400, f"invalid Assistant {submission.challenge_type} submission") from exc
    if connection.active is not None or connection.sync_task is not None:
        raise FrameError(409, "a chat operation is already active")
    if connection.pending_challenge_id is None:
        raise FrameError(409, submission.missing_message)
    if connection.pending_challenge_type != submission.challenge_type:
        raise FrameError(409, submission.other_pending_message)
    if payload["challenge_id"] != connection.pending_challenge_id:
        raise FrameError(409, submission.stale_message)
    return payload


async def _dispatch_submit(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
    submission: _Submission,
) -> None:
    try:
        payload = _prepare_submission(connection, frame, submission)
    except FrameError as exc:
        await _send_event(websocket, _error_terminal(exc.status, exc.detail))
        return
    try:
        future = _TURN_EXECUTOR.submit(getattr(localchat, submission.submit_name), team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation=submission.operation)
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
    submission = _SUBMISSIONS.get(frame_type) if isinstance(frame_type, str) else None
    if frame_type == "sync" and set(frame) == {"type"}:
        await _dispatch_sync(websocket, connection, team_id)
    elif frame_type == "chat":
        await _dispatch_chat(websocket, connection, team_id, frame)
    elif submission is not None:
        await _dispatch_submit(websocket, connection, team_id, frame, submission)
    elif frame_type == "stop" and set(frame) == {"type"}:
        await _dispatch_stop(websocket, connection, team_id)
    else:
        await _send_event(websocket, _error_terminal(400, "unsupported chat frame"))


def _has_subprotocol(websocket: WebSocket) -> bool:
    protocols = websocket.scope.get("subprotocols", [])
    return protocols == [CHAT_SUBPROTOCOL]


def _session_valid(session_ok: Callable[[Mapping[str, str]], bool], cookies: Mapping[str, str]) -> bool:
    # Authentication callbacks fail closed on every ordinary validation error.
    with contextlib.suppress(Exception):
        return session_ok(cookies) is True
    return False


async def serve(
    websocket: WebSocket,
    team_id: object,
    *,
    session_ok: Callable[[Mapping[str, str]], bool],
) -> None:
    """Serve one authenticated local chat socket without letting it outlive its Admin session."""
    origin = canonical_origin(websocket.headers.get("origin"))
    if origin is None or origin not in ALLOWED_ORIGINS:
        await websocket.close(code=4403)
        return
    if not _has_subprotocol(websocket):
        await websocket.close(code=4406)
        return
    try:
        canonical_id = teams.canonical_team_id(team_id)
    except teams.TeamRequestError:
        await websocket.close(code=4400)
        return
    if not _session_valid(session_ok, websocket.cookies):
        await websocket.close(code=4401)
        return

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
            if not _session_valid(session_ok, websocket.cookies):
                connection.closed = True
                await websocket.close(code=4401)
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
