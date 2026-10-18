"""A Browser task's screen for the watching Supervisor: one binary WebSocket Admin relays to Team (ADR-0117).

`GET /api/teams/{team_id}/browser/views/{view_id}/stream` is admitted exactly as the session socket is — one admitted
Origin, Fetch Metadata saying Admin's own page opened it, the exact subprotocol (`binary`), and a current Supervisor
session — and stays bound to that Origin and session, checked again every few seconds. Admin then reaches Team over a
connection of its own (no proxy, no redirect followed) with the Supervisor's assertion for that exact path, and relays
binary messages both ways through bounded queues with send deadlines. The screen's bytes are never read, stored, or
logged. At most MAX_STREAMS streams run at once, and either side ending, the session ending, or its Origin no longer
being admitted ends the stream; the session and Origin are watched from the moment the stream is accepted.
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
# Close codes the page reads once its stream was accepted: Team answered that the task no longer runs, the view is busy
# or unavailable, the session ended, or the stream simply ended (the page then asks for the view again).
ENDED = 4404
BUSY = 4429
SIGNED_OUT = registry.SIGNED_OUT
UNAVAILABLE = 1013
FINISHED = 1000
_TEAM_REFUSALS = {404: ENDED, 503: UNAVAILABLE}
_VIEW_ID = re.compile(r"[0-9a-f]{32}")


async def serve(websocket: WebSocket, gate: session_socket.Gate, team_id: str, view_id: str) -> None:
    """Admit the page's stream, then relay it to Team until either side or the session ends."""
    origin = await _admit(websocket, gate)
    if origin is None:
        return
    canonical_team = payloads.canonical_team_id(team_id)
    # Past admission the page hears why its stream did not run, as a close code on an accepted stream.
    await websocket.accept(subprotocol=view_contract.SUBPROTOCOL)
    if canonical_team is None or _VIEW_ID.fullmatch(view_id) is None:
        await _close(websocket, ENDED)
        return
    if not _STREAMS.acquire(blocking=False):
        await _close(websocket, BUSY)
        return
    try:
        path = f"/v1/teams/{canonical_team}/browser/views/{view_id}/stream"
        await _close(websocket, await _relay(websocket, gate, origin, path))
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


async def _close(websocket: WebSocket, code: int) -> None:
    """Close the page's stream with `code`, waiting no longer than CLOSE_SECONDS for it."""
    with contextlib.suppress(Exception):
        await asyncio.wait_for(websocket.close(code=code), CLOSE_SECONDS)


async def _relay(websocket: WebSocket, gate: session_socket.Gate, origin: str, path: str) -> int:
    """Relay the stream until it ends; the close code for the page.

    The session and Origin are watched from the start, so a revocation while Team is reached ends the opening, and
    they are checked once more before the first byte passes.
    """
    cookies = dict(websocket.cookies)
    watch = asyncio.create_task(_session_holds(gate, origin, cookies))
    opening = asyncio.create_task(_open_team(gate, cookies, path))
    team = None
    try:
        await asyncio.wait({watch, opening}, return_when=asyncio.FIRST_COMPLETED)
        if watch.done():
            return SIGNED_OUT
        team, refusal = opening.result()
        if team is None:
            return refusal
        if not await _session_admitted(gate, origin, cookies):
            return SIGNED_OUT
        pumps = {asyncio.create_task(_to_team(websocket, team)), asyncio.create_task(_to_page(websocket, team))}
        try:
            done, _ = await asyncio.wait({watch, *pumps}, return_when=asyncio.FIRST_COMPLETED)
            return SIGNED_OUT if watch in done else next(iter(done)).result()
        finally:
            for task in pumps:
                task.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
    finally:
        watch.cancel()
        opening.cancel()
        await asyncio.gather(watch, opening, return_exceptions=True)
        # An opening that reached Team although the stream ended first, even in the same instant, is closed too.
        if team is None and not opening.cancelled() and opening.exception() is None:
            team = opening.result()[0]
        if team is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(team.close(), CLOSE_SECONDS)


async def _open_team(gate: session_socket.Gate, cookies: dict[str, str], path: str):
    """Team's side of the stream, or None and the close code its refusal or failure means for the page."""

    def reach_team():
        with gate.request_scope(cookies):
            return transport.stream_connection(path)

    reaching = asyncio.ensure_future(run_in_threadpool(reach_team))
    try:
        connection, headers, uri = await asyncio.shield(reaching)
    except asyncio.CancelledError:
        # The connection a cancelled opening still makes is closed once it arrives.
        reaching.add_done_callback(_close_reached)
        raise
    except OSError:
        return None, UNAVAILABLE
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
        return None, _TEAM_REFUSALS.get(exc.response.status_code, UNAVAILABLE)
    except InvalidHandshake, OSError, TimeoutError:
        connection.close()
        return None, UNAVAILABLE
    except asyncio.CancelledError:
        connection.close()
        raise
    if team.subprotocol != view_contract.SUBPROTOCOL:
        # Team answers exactly one upgrade, with the binary subprotocol; anything else is not the display.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(team.close(), CLOSE_SECONDS)
        return None, UNAVAILABLE
    return team, None


def _close_reached(reaching: asyncio.Future) -> None:
    if not reaching.cancelled() and reaching.exception() is None:
        reaching.result()[0].close()


async def _to_team(websocket: WebSocket, team) -> int:
    """The page's messages to Team: binary only, within the bound, each sent before its deadline."""
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return FINISHED
            data = message.get("bytes")
            if data is None or len(data) > MAX_MESSAGE_BYTES:
                return UNAVAILABLE
            await asyncio.wait_for(team.send(data), SEND_SECONDS)
    except ConnectionClosed, TimeoutError:
        return UNAVAILABLE


async def _to_page(websocket: WebSocket, team) -> int:
    """Team's messages to the page: binary only, each sent before its deadline."""
    try:
        async for message in team:
            if not isinstance(message, bytes):
                return UNAVAILABLE
            await asyncio.wait_for(websocket.send_bytes(message), SEND_SECONDS)
    except WebSocketDisconnect, ConnectionClosed, TimeoutError, RuntimeError:
        return UNAVAILABLE
    return FINISHED


async def _session_admitted(gate: session_socket.Gate, origin: str, cookies: dict[str, str]) -> bool:
    """Whether the session is still current and its Origin still admitted."""
    try:
        admitted = origin in gate.allowed_origins()
    except RuntimeError, OSError:
        admitted = False
    return admitted and await registry.session_status(gate.session_current, cookies) == "active"


async def _session_holds(gate: session_socket.Gate, origin: str, cookies: dict[str, str]) -> None:
    """Return once the session is no longer current or its Origin no longer admitted."""
    while True:
        if not await _session_admitted(gate, origin, cookies):
            return
        await asyncio.sleep(SESSION_CHECK_SECONDS)
