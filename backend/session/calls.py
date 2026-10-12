"""The Admin operations a session socket call names (ADR-0114 decision 3).

Each read is the same backend function its HTTP route ran, with the same validation, Team identity checks, limits, and
answers, on a bounded worker lane that answers 429 when full. A call checked at receipt may wait, for its task or for a
lane worker: it runs only if its socket's Origin and session are still current when its turn comes, and otherwise the
socket closes and the call is never answered. Downstream Supervisor authority is bound again from the
current signing identity for every call, never kept from the handshake. A read's result carries the revision of the
topic it reflects, taken before the read, so a change that lands meanwhile is never mistaken for being seen.
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import supervisor
from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import HTTPException
from fastapi.responses import Response
from history import http as history_http
from protocol.socket.v1 import frames
from session import budget, topics, watcher
from session.outbound import OutboundOverflowError
from signin import audit, auth, security
from space import release as platform_release
from team import bridge as team
from team import http as team_http
from team import order as team_order

from routine import http as routine_http

if TYPE_CHECKING:
    from session.socket import SessionSocket

log = logging.getLogger("shimpz-admin")

# The calls a socket's reads run on: a slow Team read never holds the receive loop, and a full lane answers 429.
LANE = BoundedThreadPoolExecutor(max_workers=4, max_outstanding=32, thread_name_prefix="shimpz-session-call")
UNAVAILABLE_AUTHORITY = (503, {"detail": "Supervisor authority is unavailable"})
SOCKET_UNAVAILABLE = 1013
# The longest a lane worker waits for its socket's Origin and session check before the socket closes as unavailable.
CHECK_SECONDS = 10.0

Answer = tuple[int, object]


def _answer(response: object) -> Answer:
    """An HTTP handler's answer as a call result: its status and JSON body."""
    if isinstance(response, Response):
        return response.status_code, json.loads(response.body)
    return 200, response


def _http(handler: Callable[..., object], *args: object) -> Answer:
    try:
        return _answer(handler(*args))
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}


class RefusedError(Exception):
    """The socket's Origin or session is no longer current when a waiting call's turn came: the socket closes."""


def _current(socket: SessionSocket) -> bool:
    """On a lane worker: check the socket's Origin and session on its loop, never renewing the session."""
    check = asyncio.run_coroutine_threadsafe(socket.authorized(), socket.loop)
    try:
        return check.result(timeout=CHECK_SECONDS)
    except TimeoutError:
        check.cancel()
        socket.end(SOCKET_UNAVAILABLE)
        return False


def _checked(socket: SessionSocket, handler: Callable[..., object], *args: object) -> Answer:
    if not _current(socket):
        raise RefusedError
    return _http(handler, *args)


async def _lane(socket: SessionSocket, handler: Callable[..., object], *args: object) -> Answer:
    try:
        future = submit_in_context(LANE, _checked, socket, handler, *args)
    except ExecutorSaturatedError:
        return 429, {"detail": "Admin session call capacity reached"}
    return await asyncio.wrap_future(future)


async def _teams(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await _lane(socket, team_order.listing)


async def _history(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await _lane(socket, history_http.page, params["team_id"], params.get("before"), params.get("routine"))


async def _routines(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await _lane(socket, routine_http.routines_list, params["team_id"])


async def _resources(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await _lane(socket, team_http.response, team.space_resources)


async def _release(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await _lane(socket, platform_release.status_response)


async def _security(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await _lane(socket, security.summary_for, socket.cookies.get(socket.gate.cookie, ""))


async def _subscribe(socket: SessionSocket, params: dict[str, object]) -> Answer:
    named = frames.topics(params)
    if len(socket.subscriptions | set(named)) > frames.MAX_SUBSCRIPTIONS:
        return 409, {"detail": "a session socket subscribes to at most 64 topics"}
    socket.subscriptions.update(named)
    watcher.WATCHER.refresh()
    return 200, _subscription(socket)


async def _unsubscribe(socket: SessionSocket, params: dict[str, object]) -> Answer:
    socket.subscriptions.difference_update(frames.topics(params))
    watcher.WATCHER.refresh()
    return 200, _subscription(socket)


def _subscription(socket: SessionSocket) -> dict[str, object]:
    """The socket's topics and each one's current revision in this epoch."""
    return {
        "epoch": topics.EPOCH,
        "topics": {topic: topics.revision(topic) for topic in sorted(socket.subscriptions)},
    }


async def _attach(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return socket.attach(params["team_id"], params["locale"])


async def _detach(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return socket.detach(params["team_id"])


METHODS: dict[str, Callable[[SessionSocket, dict[str, object]], Awaitable[Answer]]] = {
    "teams.list": _teams,
    "history.page": _history,
    "routines.list": _routines,
    "space.resources": _resources,
    "platform.release": _release,
    "security.summary": _security,
    "subscribe": _subscribe,
    "unsubscribe": _unsubscribe,
    "chat.attach": _attach,
    "chat.detach": _detach,
}


def admission(socket: SessionSocket, method: str) -> str | None:
    """Count one call against its session's budgets, or the reason it is refused."""
    if not budget.CALL_BUDGET.admit(socket.session):
        return "session call budget reached"
    if method in frames.CHANGE_METHODS and not budget.CHANGE_BUDGET.admit(socket.session):
        return "session change budget reached"
    return None


async def _dispatch(socket: SessionSocket, method: str, params: dict[str, object]) -> Answer:
    """Run one method under the current Supervisor authority, answering its failures as the HTTP gate does."""
    try:
        # A read reaches Team under the current Supervisor authority; changing what the socket holds needs none.
        with socket.gate.request_scope(socket.cookies) if method in frames.READ_TOPICS else contextlib.nullcontext():
            return await METHODS[method](socket, params)
    except RefusedError:
        raise
    except team.TeamRequestError, supervisor.SupervisorAuthorityError:
        return UNAVAILABLE_AUTHORITY
    except auth.PasswordRecordError:
        return 503, {"code": "password-recovery-required", "detail": "Supervisor password recovery is required"}
    except audit.AuditUnavailableError:
        return 503, {"detail": "Supervisor authentication audit is unavailable"}
    except Exception:
        # Every call ends in exactly one result: an unexpected failure is the server error HTTP would answer.
        log.exception("session socket call %s failed", method)
        return 500, {"detail": "Internal Server Error"}


async def run(socket: SessionSocket, call_id: str, method: str, params: dict[str, object]) -> None:
    """Answer one call with exactly one result; a result too large for one frame is answered as a failure.

    A read checks its socket again on the lane worker that runs it; any other call checks it as its task starts.
    """
    if method not in frames.READ_TOPICS and not await socket.authorized():
        return
    topic = frames.READ_TOPICS[method](params) if method in frames.READ_TOPICS else None
    revision = (topic, topics.EPOCH, topics.revision(topic)) if topic is not None and frames.is_topic(topic) else None
    try:
        status, body = await _dispatch(socket, method, params)
    except RefusedError:
        return
    frame = frames.result(call_id, status, body, revision if 200 <= status < 300 else None)
    try:
        frames.encode(frame)
    except ValueError:
        log.warning("session socket result for %s exceeds the frame bound", method)
        frame = frames.result(call_id, 502, {"detail": "the result exceeds the session frame bound"})
    try:
        socket.send(frame)
    except OutboundOverflowError, RuntimeError:
        return
