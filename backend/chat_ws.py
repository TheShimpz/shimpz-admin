"""Bounded, session-authenticated WebSocket transport for local Team chat.

The browser speaks only ``shimpz.chat.v1``. Provider credentials and the controller contract stay
behind :mod:`localchat`; this module admits one turn per socket, keeps Stop responsive on its own
bounded worker lane, and projects every completed operation onto a small public terminal schema.
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

CHAT_SUBPROTOCOL = "shimpz.chat.v1"
MAX_FRAME_BYTES = 128 * 1024
MAX_PUBLIC_REPLY_CHARS = 60_000
MAX_PUBLIC_TEAM_NAME_CHARS = 80
MAX_PUBLIC_ERROR_CHARS = 800
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
_REPLY_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_CHAT_ERROR_DETAILS = {
    "assistant-power-blocked": "Assistant Power execution is blocked until it is reinstalled",
    "assistant-registry-drift": "an installed Assistant is no longer available",
    "assistant-unavailable": "the Brain requested an unavailable Assistant",
    "brain-runtime-failed": "the Brain runtime could not complete the Team turn",
    "chat-active": "this Team already has an active chat turn",
    "chat-request-failed": "the local chat request failed",
    "chat-response-invalid": "the local chat returned an invalid response",
    "chat-stopped": "the chat turn was stopped",
    "file-not-found": "a selected file was not found",
    "inference-not-configured": "the Team model provider is not configured",
    "inference-provider-mismatch": "the configured model provider changed; retry",
    "inference-response-invalid": "the Team model configuration is invalid",
    "invalid-files": "the selected files are invalid",
    "invalid-power-input": "an Assistant Power received invalid input",
    "model-credential-missing": "the selected model provider needs an API key",
    "model-credential-store-invalid": "the model credential store is invalid",
    "ownership-conflict": "the Team resource ownership check failed",
    "power-approval-required": "an Assistant Power requires approval",
    "power-state-unavailable": "the Team Power execution state is unavailable",
    "runtime-unavailable": "the local chat runtime is unavailable; update this Shimpz Space",
    "team-context-changed": "the Team capabilities changed; retry",
    "team-has-no-active-assistants": "install and start at least one Assistant before chatting",
}


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


def _valid_team_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= MAX_PUBLIC_TEAM_NAME_CHARS
        and _CONTROL_RE.search(value) is None
    )


def _valid_reply(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= MAX_PUBLIC_REPLY_CHARS
        and _REPLY_CONTROL_RE.search(value) is None
    )


def _safe_status(value: object, fallback: int = 502) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599 else fallback


def _error_terminal(status: object, detail: str = "local chat request failed") -> dict[str, object]:
    safe_detail = (
        detail
        if 0 < len(detail) <= MAX_PUBLIC_ERROR_CHARS and _CONTROL_RE.search(detail) is None
        else "local chat request failed"
    )
    return {"type": "error", "status": _safe_status(status), "detail": safe_detail}


def turn_terminal(response: object, team_id: str) -> dict[str, object]:
    """Project a secret-safe localchat response onto the public v1 terminal contract."""
    if not isinstance(response, teams.DriverResponse):
        return _error_terminal(502)
    if isinstance(response.status, int) and not isinstance(response.status, bool) and 200 <= response.status < 300:
        body = response.body
        if (
            isinstance(body, dict)
            and set(body) == {"team_id", "team_name", "reply"}
            and body.get("team_id") == team_id
            and _valid_team_name(body.get("team_name"))
            and _valid_reply(body.get("reply"))
        ):
            return {"type": "done", "reply": body["reply"], "team_name": body["team_name"]}
        return _error_terminal(502, "local chat returned an invalid response")

    # ``localchat`` reduces controller/provider failures to one bounded machine code. Map only this
    # closed allowlist to fixed public text; raw prose, tracebacks and credentials never cross here.
    details = {
        400: "invalid chat request",
        409: "chat turn could not start",
        429: "local chat capacity reached",
        503: "local chat runtime is unavailable",
    }
    status = _safe_status(response.status)
    fallback = details.get(status, "local chat request failed")
    body = response.body
    if not isinstance(body, dict) or set(body) != {"code"}:
        return _error_terminal(status, fallback)
    code = body.get("code")
    if not isinstance(code, str) or code not in _CHAT_ERROR_DETAILS:
        return _error_terminal(status, fallback)
    return _error_terminal(status, f"{code}: {_CHAT_ERROR_DETAILS[code]}")


def _stop_accepted(response: object, team_id: str) -> bool | None:
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
    ):
        return None
    if set(response.body) != {"team_id", "stopped"} or response.body.get("team_id") != team_id:
        return None
    stopped = response.body.get("stopped")
    return stopped if isinstance(stopped, bool) else None


@dataclass(slots=True)
class _Turn:
    future: concurrent.futures.Future
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False


@dataclass(slots=True)
class _Connection:
    active: _Turn | None = None
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
        response = teams.DriverResponse(502, {})
        # A provider callback may raise any ordinary exception. This process boundary must fail
        # closed while cancellation and process-control BaseExceptions continue to propagate.
        with contextlib.suppress(Exception):
            try:
                response = await asyncio.wrap_future(turn.future)
            except asyncio.CancelledError:
                raise
            except teams.TeamRequestError:
                response = teams.DriverResponse(400, {})
        await _send_terminal_once(websocket, connection, turn, turn_terminal(response, team_id))
    finally:
        if connection.active is turn:
            connection.active = None


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
            await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
        elif accepted is None:
            status = response.status if isinstance(response, teams.DriverResponse) else 502
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                _error_terminal(status, "chat turn could not be stopped"),
            )
        # ``False`` races safely with a turn that has already finished; its normal terminal wins.
    finally:
        turn.stop_task = None


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
    if turn.future.cancel():
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_send_terminal_once(websocket, connection, turn, {"type": "stopped"}))
        return turn.stop_task
    turn.stop_task = asyncio.create_task(_run_stop(websocket, connection, turn, team_id, emit=emit))
    return turn.stop_task


async def _dispatch(websocket: WebSocket, connection: _Connection, team_id: str, frame: dict[str, object]) -> None:
    if frame.get("type") == "chat":
        if set(frame) not in ({"type", "message"}, {"type", "message", "files"}):
            await _send_event(websocket, _error_terminal(400, "chat frame accepts only message and files"))
            return
        try:
            payload = teams.canonical_chat_payload({key: value for key, value in frame.items() if key != "type"})
        except teams.TeamRequestError:
            await _send_event(websocket, _error_terminal(400, "invalid chat request"))
            return
        if connection.active is not None:
            await _send_event(websocket, _error_terminal(409, "a chat turn is already active"))
            return
        try:
            future = _TURN_EXECUTOR.submit(localchat.turn, team_id, payload)
        except ExecutorSaturatedError:
            await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
            return
        turn = _Turn(future=future)
        connection.active = turn
        turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))
        return

    if frame.get("type") == "stop" and set(frame) == {"type"}:
        if connection.active is None:
            await _send_event(websocket, _error_terminal(409, "no active chat turn"))
            return
        _request_stop(websocket, connection, connection.active, team_id, emit=True)
        return

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
        active = connection.active
        if active is not None:
            stop_task = _request_stop(websocket, connection, active, canonical_id, emit=False)
            if stop_task is not None:
                with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                    await asyncio.wait_for(asyncio.shield(stop_task), timeout=15)
            if active.delivery is not None:
                active.delivery.cancel()
                await asyncio.gather(active.delivery, return_exceptions=True)
