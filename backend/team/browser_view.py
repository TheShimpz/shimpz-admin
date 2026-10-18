"""A Browser task's screen for the watching Supervisor: one binary WebSocket Admin relays to Team (ADR-0117).

`GET /api/teams/{team_id}/browser/views/{view_id}/stream` is admitted exactly as the session socket is — one admitted
Origin, Fetch Metadata saying Admin's own page opened it, the exact subprotocol (`binary`), and a current Supervisor
session — and stays bound to that Origin and session, checked again every few seconds. Admin then reaches Team over a
connection of its own (no proxy, no redirect followed) with the Supervisor's assertion for that exact path, and relays
binary messages both ways through bounded queues with send deadlines. The screen's bytes are never read, stored, or
logged. At most MAX_STREAMS streams run at once, and either side ending, the session ending, or its Origin no longer
being admitted ends the stream.
"""

import asyncio
import contextlib
import logging
import re
import threading

from fastapi import WebSocket, WebSocketDisconnect
from session import registry
from session import socket as session_socket
from starlette.concurrency import run_in_threadpool
from team import transport
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from chat import payloads
from protocol.http.v1 import browser_view as view_contract

log = logging.getLogger("shimpz-admin")

MAX_STREAMS = 2
_STREAMS = threading.BoundedSemaphore(MAX_STREAMS)
# The largest message either side may send: the display's updates are split well below it, the viewer's are tiny.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
# Messages waiting in each direction, and the bytes buffered for writing to Team.
QUEUE_MESSAGES = 2
WRITE_LIMIT_BYTES = 1024 * 1024
OPEN_SECONDS = 10
SEND_SECONDS = 10
CLOSE_SECONDS = 2
SESSION_CHECK_SECONDS = 5
# Close codes the page reads: the task no longer runs, the view is busy or unavailable, or the session ended.
ENDED = 4404
BUSY = 4429
SIGNED_OUT = registry.SIGNED_OUT
UNAVAILABLE = 1013
_TEAM_REFUSALS = {404: ENDED, 503: UNAVAILABLE}
_VIEW_ID = re.compile(r"[0-9a-f]{32}")


async def serve(websocket: WebSocket, gate: session_socket.Gate, team_id: str, view_id: str) -> None:
    """Admit the page's stream, then relay it to Team until either side or the session ends."""
    origin = await _admit(websocket, gate)
    if origin is None:
        return
    canonical_team = payloads.canonical_team_id(team_id)
    if canonical_team is None or _VIEW_ID.fullmatch(view_id) is None:
        await websocket.close(code=ENDED)
        return
    if not _STREAMS.acquire(blocking=False):
        await websocket.close(code=BUSY)
        return
    try:
        await websocket.accept(subprotocol=view_contract.SUBPROTOCOL)
        path = f"/v1/teams/{canonical_team}/browser/views/{view_id}/stream"
        await _relay(websocket, gate, origin, path)
    finally:
        _STREAMS.release()


async def _admit(websocket: WebSocket, gate: session_socket.Gate) -> str | None:
    """The page's admitted Origin, or None after refusing the handshake before accepting it."""
    try:
        origins = gate.allowed_origins()
    except RuntimeError, OSError:
        log.exception("browser stream origin authority is unavailable")
        await websocket.close(code=UNAVAILABLE)
        return None
    origin = session_socket.admitted_origin(websocket, origins)
    if origin is None:
        await websocket.close(code=session_socket.ORIGIN_REFUSED)
        return None
    if websocket.scope.get("subprotocols", []) != [view_contract.SUBPROTOCOL]:
        await websocket.close(code=session_socket.PROTOCOL_REFUSED)
        return None
    status = await registry.session_status(gate.session_current, websocket.cookies)
    if status != "active":
        await websocket.close(code=UNAVAILABLE if status == "unavailable" else SIGNED_OUT)
        return None
    return origin


async def _relay(websocket: WebSocket, gate: session_socket.Gate, origin: str, path: str) -> None:
    cookies = dict(websocket.cookies)

    def reach_team():
        with gate.request_scope(cookies):
            return transport.stream_connection(path)

    try:
        connection, headers, uri = await run_in_threadpool(reach_team)
    except OSError:
        await websocket.close(code=UNAVAILABLE)
        return
    try:
        team = await connect(
            uri,
            sock=connection,
            additional_headers=headers,
            subprotocols=[view_contract.SUBPROTOCOL],
            compression=None,
            proxy=None,
            open_timeout=OPEN_SECONDS,
            close_timeout=CLOSE_SECONDS,
            ping_interval=None,
            max_size=MAX_MESSAGE_BYTES,
            max_queue=QUEUE_MESSAGES,
            write_limit=WRITE_LIMIT_BYTES,
            user_agent_header=None,
        )
    except InvalidStatus as exc:
        connection.close()
        await websocket.close(code=_TEAM_REFUSALS.get(exc.response.status_code, UNAVAILABLE))
        return
    except InvalidHandshake, OSError, TimeoutError:
        connection.close()
        await websocket.close(code=UNAVAILABLE)
        return
    if team.subprotocol != view_contract.SUBPROTOCOL:
        # Team answers exactly one upgrade, with the binary subprotocol; anything else is not the display.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(team.close(), CLOSE_SECONDS)
        await websocket.close(code=UNAVAILABLE)
        return
    ended = asyncio.Event()
    tasks = [
        asyncio.create_task(_to_team(websocket, team)),
        asyncio.create_task(_to_page(websocket, team)),
        asyncio.create_task(_session_holds(websocket, gate, origin, cookies, ended)),
    ]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(team.close(), CLOSE_SECONDS)
        code = SIGNED_OUT if ended.is_set() else ENDED
        with contextlib.suppress(Exception):
            await websocket.close(code=code)


async def _to_team(websocket: WebSocket, team) -> None:
    """The page's messages to Team: binary only, within the bound, each sent before its deadline."""
    with contextlib.suppress(WebSocketDisconnect, ConnectionClosed, TimeoutError):
        while True:
            message = await websocket.receive()
            data = message.get("bytes")
            if message.get("type") == "websocket.disconnect" or data is None or len(data) > MAX_MESSAGE_BYTES:
                return
            await asyncio.wait_for(team.send(data), SEND_SECONDS)


async def _to_page(websocket: WebSocket, team) -> None:
    """Team's messages to the page: binary only, each sent before its deadline."""
    with contextlib.suppress(WebSocketDisconnect, ConnectionClosed, TimeoutError, RuntimeError):
        async for message in team:
            if not isinstance(message, bytes):
                return
            await asyncio.wait_for(websocket.send_bytes(message), SEND_SECONDS)


async def _session_holds(websocket, gate, origin: str, cookies: dict[str, str], ended: asyncio.Event) -> None:
    """Return once the session is no longer current or its Origin no longer admitted, marking why."""
    while True:
        await asyncio.sleep(SESSION_CHECK_SECONDS)
        try:
            admitted = origin in gate.allowed_origins()
        except RuntimeError, OSError:
            admitted = False
        if not admitted or await registry.session_status(gate.session_current, cookies) != "active":
            ended.set()
            return
