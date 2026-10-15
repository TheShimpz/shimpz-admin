"""The bounded worker lanes a session socket's calls run on (ADR-0114 decision 3).

A call runs the same backend function its HTTP route ran, with the same validation, Team identity checks, and answers,
on a bounded lane that answers as a full one did (429 unless the operation always had its own answer). A call checked at
receipt may wait for a lane worker: it runs only if its socket's Origin and session are still current when its turn
comes, and otherwise the socket closes and the call is never answered.
"""

import asyncio
import contextlib
import json
from collections.abc import Callable
from concurrent.futures import Executor
from typing import TYPE_CHECKING

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import HTTPException
from fastapi.responses import Response
from team import transport

if TYPE_CHECKING:
    from session.socket import SessionSocket

# The calls a socket's reads and short changes run on: a slow Team call never holds the receive loop.
LANE = BoundedThreadPoolExecutor(max_workers=4, max_outstanding=32, thread_name_prefix="shimpz-session-call")
# Assistant installs run for minutes; their own lane keeps them from holding every read behind them.
INSTALL_LANE = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=4, thread_name_prefix="shimpz-session-install")
# A frozen Routine run resumes for up to its active time; its own lane keeps it from holding reads or installs.
RESUME_LANE = BoundedThreadPoolExecutor(max_workers=4, max_outstanding=8, thread_name_prefix="shimpz-session-resume")
FULL = (429, {"detail": "Admin session call capacity reached"})
SOCKET_UNAVAILABLE = 1013
# The longest a lane worker waits for its socket's Origin and session check before the socket closes as unavailable.
CHECK_SECONDS = 10.0

Answer = tuple[int, object]


def answer(response: object) -> Answer:
    """An operation's answer as a call result: its status and JSON body; an empty body is an empty object."""
    if isinstance(response, Response):
        return response.status_code, json.loads(response.body) if response.body else {}
    if isinstance(response, transport.TeamResponse):
        return response.status, response.body
    if isinstance(response, tuple):
        return response
    return 200, response


def http(handler: Callable[..., object], *args: object) -> Answer:
    """Run one operation, answering a refusal it raised as the HTTP route answered it."""
    try:
        return answer(handler(*args))
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}


class RefusedError(Exception):
    """The socket's Origin or session is no longer current when a waiting call's turn came: the socket closes."""


def current(socket: SessionSocket) -> bool:
    """On a lane worker: check the socket's Origin and session on its loop, never renewing it.

    A loop that already closed runs nothing more, a check it cannot answer in time closes the socket, and a socket that
    closed while the answer came back to this worker is not current.
    """
    authorized = socket.authorized()
    try:
        check = asyncio.run_coroutine_threadsafe(authorized, socket.loop)
    except RuntimeError:
        authorized.close()
        return False
    try:
        return check.result(timeout=CHECK_SECONDS) and not socket.closed.is_set()
    except TimeoutError:
        check.cancel()
        with contextlib.suppress(RuntimeError):
            socket.end(SOCKET_UNAVAILABLE)
        return False


Started = Callable[[], None] | None


def _checked(socket: SessionSocket, started: Started, handler: Callable[..., object], *args: object) -> Answer:
    if not current(socket):
        raise RefusedError
    if started is not None:
        started()
    return http(handler, *args)


async def run(
    socket: SessionSocket,
    handler: Callable[..., object],
    *args: object,
    executor: Executor = LANE,
    full: Answer = FULL,
    started: Started = None,
) -> Answer:
    """Run one operation on a lane worker once the socket is still current there; `started` runs just before it."""
    try:
        future = submit_in_context(executor, _checked, socket, started, handler, *args)
    except ExecutorSaturatedError:
        return full
    return await asyncio.wrap_future(future)
