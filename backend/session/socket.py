"""One authenticated Admin session socket per browser tab (ADR-0114): `GET /api/session/ws`, `shimpz.admin.v1`.

The socket is admitted exactly as Admin's own page is: one canonical admitted Origin, Fetch Metadata that says the page
itself opened it, the exact subprotocol, and a current Supervisor session. It stays bound to that Origin and session.
Before every frame it acts on, Admin checks again that the Origin is still admitted and the session still current, and
closes the socket when either is not (4403, 4401). A person's own frame renews the session's idle time; an automatic
read (`background`) and the page's own sync never do. The receive loop never waits for a call or a write.
"""

import asyncio
import contextlib
import logging
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

import browser
from fastapi import WebSocket, WebSocketDisconnect
from mfa import tickets
from protocol.socket.v1 import frames
from session import budget, calls, registry, topics, watcher
from session.outbound import Outbound, OutboundOverflowError
from signin import auth

from chat import socket as chat_channel
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

log = logging.getLogger("shimpz-admin")

SIGNED_OUT = registry.SIGNED_OUT
ORIGIN_REFUSED = 4403
PROTOCOL_REFUSED = 4406
UNAVAILABLE = 1013
POLICY = 1008
# A margin past a session's expiry before its timer checks it, so the check never runs a moment too early.
EXPIRY_MARGIN_SECONDS = 0.05
# The longest a quiet socket goes without checking its Origin and session again.
SESSION_CHECK_SECONDS = 60

SessionCheck = Callable[[Mapping[str, str]], Awaitable[bool]]


@dataclass(frozen=True, slots=True)
class Gate:
    """What Admin's own HTTP gate decides, given to the socket: sessions, origins, authority, and Action passwords."""

    session_current: SessionCheck
    session_active: SessionCheck
    allowed_origins: Callable[[], frozenset[str]]
    request_scope: Callable[[Mapping[str, str]], contextlib.AbstractContextManager[None]]
    session_remaining: Callable[[Mapping[str, str]], float | None]
    authenticate: Callable[[str, str], Awaitable[object]]
    revoke_tickets: Callable[[tickets.Binding], None]
    cookie: str


def _admitted_origin(websocket: WebSocket, origins: frozenset[str]) -> str | None:
    """The one exact admitted Origin the page opened the socket from, under the HTTP gate's own page check."""
    sent = websocket.headers.getlist("origin")
    if len(sent) != 1 or not browser.from_admin_page(websocket, lambda: origins):
        return None
    return sent[0]


async def _admit(websocket: WebSocket, gate: Gate) -> tuple[str, str] | None:
    """Admit the handshake, returning the bound Origin and session digest, or refuse it before accepting."""
    try:
        origins = gate.allowed_origins()
    except RuntimeError, OSError:
        log.exception("session socket origin authority is unavailable")
        await websocket.close(code=UNAVAILABLE)
        return None
    origin = _admitted_origin(websocket, origins)
    if origin is None:
        await websocket.close(code=ORIGIN_REFUSED)
        return None
    if websocket.scope.get("subprotocols", []) != [frames.SUBPROTOCOL]:
        await websocket.close(code=PROTOCOL_REFUSED)
        return None
    status = await registry.session_status(gate.session_current, websocket.cookies)
    if status != "active":
        await websocket.close(code=UNAVAILABLE if status == "unavailable" else SIGNED_OUT)
        return None
    session = auth.session_key(websocket.cookies.get(gate.cookie, ""))
    if not budget.OPENS.admit(session):
        await websocket.close(code=UNAVAILABLE)
        return None
    return origin, session


class SessionSocket:
    """One admitted socket: its outbound queue, in-flight calls, subscriptions, and attached chat channels."""

    def __init__(self, websocket: WebSocket, gate: Gate, origin: str, session: str) -> None:
        self.websocket = websocket
        self.gate = gate
        self.origin = origin
        self.session = session
        self.cookies = dict(websocket.cookies)
        self.outbound = Outbound()
        self.calls: dict[str, asyncio.Task] = {}
        self.subscriptions: set[str] = set()
        self.channels: dict[str, chat_channel.Channel] = {}
        self.detaching: set[asyncio.Task] = set()
        self.closed = asyncio.Event()
        self.close_code = 1000
        self.loop = asyncio.get_running_loop()
        self.step_up = tickets.Binding(session, secrets.token_hex(16))
        self.handle = registry.Handle(
            session,
            self.step_up.socket,
            self.cookies,
            self.end,
            self.subscriptions.__contains__,
            gate.session_current,
            lambda: gate.request_scope(self.cookies),
        )

    # Outbound

    def send(self, frame: dict[str, object], *, topic: str | None = None) -> None:
        """Queue one server frame; an overflowing queue closes the socket and the client re-reads."""
        try:
            self.outbound.put(frames.encode(frame), topic=topic)
        except OutboundOverflowError:
            log.warning("session socket outbound queue overflowed")
            self.end(UNAVAILABLE)
            raise

    def end(self, code: int) -> None:
        """Close the socket with `code` from any thread; the first close wins."""
        self.loop.call_soon_threadsafe(self._end, code)

    def _end(self, code: int) -> None:
        if self.closed.is_set():
            return
        self.close_code = code
        self.outbound.closed = True
        self.closed.set()

    def changed(self, topic: str, revision: int) -> None:
        """A topic changed: tell the client when it subscribes to it (any thread)."""
        if topic in self.subscriptions:
            self.loop.call_soon_threadsafe(self._changed, topic, revision)

    def _changed(self, topic: str, revision: int) -> None:
        if topic in self.subscriptions and not self.closed.is_set():
            with contextlib.suppress(OutboundOverflowError):
                self.send(frames.changed(topic, topics.EPOCH, revision), topic=topic)

    # Checks

    async def _authorized(self, *, activity: bool) -> bool:
        """The bound Origin is still admitted and the session still current, or the socket closes."""
        try:
            admitted = self.origin in self.gate.allowed_origins()
        except RuntimeError, OSError:
            self._end(UNAVAILABLE)
            return False
        if not admitted:
            self._end(ORIGIN_REFUSED)
            return False
        check = self.gate.session_active if activity else self.gate.session_current
        status = await registry.session_status(check, self.cookies)
        if status != "active":
            self._end(UNAVAILABLE if status == "unavailable" else SIGNED_OUT)
            return False
        return True

    # Chat channels

    def attach(self, team_id: object, locale: object) -> tuple[int, object]:
        """Make the socket a chat connection for one more Team, which then synchronizes it as a v7 socket did."""
        if not frames.is_team_id(team_id):
            return 400, {"detail": "Team id is invalid"}
        canonical_locale = team_contract.canonical_locale(locale)
        if canonical_locale is None:
            return 400, {"detail": "locale is invalid"}
        if team_id in self.channels:
            return 409, {"detail": "the Team's chat is already attached"}
        if len(self.channels) >= frames.MAX_ATTACHED_TEAMS:
            return 409, {"detail": "a session socket attaches at most 4 Teams"}
        transport = chat_channel.Transport(
            team_id,
            lambda event: self.send(frames.chat_event(team_id, event)),
            self._end,
        )
        channel = chat_channel.Channel(
            transport,
            team_id,
            request_scope=lambda: self.gate.request_scope(self.cookies),
            authenticate=self.gate.authenticate,
        )
        self.channels[team_id] = channel
        # Today's sync, after the attach result: the pending gate, an Integration resume, or `sync-empty`.
        self.loop.call_soon(channel.submit, {"type": "sync", "locale": canonical_locale})
        return 200, {"team_id": team_id}

    def detach(self, team_id: object) -> tuple[int, object]:
        """End one Team's chat connection; its active work stops exactly as when a v7 socket closed."""
        channel = self.channels.pop(team_id, None) if isinstance(team_id, str) else None
        if channel is None:
            return 409, {"detail": "the Team's chat is not attached"}
        closing = asyncio.create_task(channel.close())
        self.detaching.add(closing)
        closing.add_done_callback(self.detaching.discard)
        return 200, {"team_id": team_id}

    # Inbound

    async def _frame(self, frame: dict[str, object]) -> None:
        kind = frame.get("type")
        if kind == "call":
            await self._call(frame)
        elif kind in frames.CHAT_TYPES:
            await self._chat(frame)
        else:
            raise frames.ProtocolError("unsupported session frame")

    async def _call(self, frame: dict[str, object]) -> None:
        call_id, method, params, background = frames.call(frame)
        if call_id in self.calls:
            raise frames.ProtocolError("duplicate call id")
        if not await self._authorized(activity=not background):
            return
        refused = calls.admission(self, method)
        if refused is None and len(self.calls) >= frames.MAX_IN_FLIGHT:
            refused = "too many calls in flight"
        if refused is not None:
            self.send(frames.result(call_id, 429, {"detail": refused}))
            return
        task = asyncio.create_task(calls.run(self, call_id, method, params))
        self.calls[call_id] = task
        task.add_done_callback(lambda _done: self.calls.pop(call_id, None))

    async def _chat(self, frame: dict[str, object]) -> None:
        team_id, chat = frames.chat_frame(frame)
        channel = self.channels.get(team_id)
        if channel is None:
            raise frames.ProtocolError("chat channel is not attached")
        if not await self._authorized(activity=chat["type"] in frames.CHAT_USER_TYPES):
            return
        if chat != {"type": "stop"} and not budget.CALL_BUDGET.admit(self.session):
            self.send(frames.chat_event(team_id, chat_channel.error_terminal(429, "session call budget reached")))
            return
        channel.submit(chat)

    async def _receive(self) -> dict[str, object] | None:
        """The next client frame, or None once the socket closed from either side."""
        receiving = asyncio.ensure_future(self.websocket.receive())
        closing = asyncio.ensure_future(self.closed.wait())
        try:
            await asyncio.wait({receiving, closing}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            closing.cancel()
        if not receiving.done():
            receiving.cancel()
            return None
        message = receiving.result()
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        return chat_ws_common.decode_bounded_json_frame(message, frames.MAX_INBOUND_BYTES)

    async def _read(self) -> None:
        while (frame := await self._receive()) is not None:
            await self._frame(frame)

    # Lifetime

    async def _write(self) -> None:
        with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
            while not self.closed.is_set():
                await self.websocket.send_text(await self.outbound.take())
        self._end(self.close_code)

    async def _expire(self) -> None:
        """Close the socket at its session's absolute or idle expiry, also while it stays quiet.

        Between expiries it checks its Origin and session at least every minute, so authority that became unavailable
        meanwhile (an unreadable store, an Origin no longer admitted) closes it too.
        """
        while not self.closed.is_set():
            try:
                remaining = self.gate.session_remaining(self.cookies)
            except RuntimeError, OSError, ValueError:
                remaining = 0.0
            if remaining is not None:
                await asyncio.sleep(min(remaining + EXPIRY_MARGIN_SECONDS, SESSION_CHECK_SECONDS))
            if not await self._authorized(activity=False):
                return

    async def serve(self) -> None:
        workers = [asyncio.create_task(self._write()), asyncio.create_task(self._expire())]
        topics.listen(self.changed)
        try:
            await self._read()
        except chat_ws_common.FrameError as exc:
            self._end(exc.close_code)
        except frames.ProtocolError as exc:
            self._end(exc.close_code)
        except WebSocketDisconnect, RuntimeError, OSError:
            self._end(1000)
        finally:
            topics.forget(self.changed)
            self._end(self.close_code)
            await self._shutdown(workers)

    async def _shutdown(self, workers: list[asyncio.Task]) -> None:
        """Stop protected work: cancel calls, close every chat channel as a closed v7 socket did, and close."""
        for task in (*workers, *self.calls.values()):
            task.cancel()
        await asyncio.gather(*workers, *self.calls.values(), return_exceptions=True)
        channels = list(self.channels.values())
        self.channels.clear()
        await asyncio.gather(*(channel.close() for channel in channels), *self.detaching, return_exceptions=True)
        registry.REGISTRY.remove(self.handle)
        # A step-up ticket issued over this socket dies with it.
        self.gate.revoke_tickets(self.step_up)
        watcher.WATCHER.refresh()
        with contextlib.suppress(RuntimeError, OSError):
            await self.websocket.close(code=self.close_code)


async def serve(websocket: WebSocket, gate: Gate) -> None:
    """Admit one session socket and serve it until it closes, never outliving its session or its admitted Origin."""
    admitted = await _admit(websocket, gate)
    if admitted is None:
        return
    socket = SessionSocket(websocket, gate, *admitted)
    if not registry.REGISTRY.add(socket.handle):
        await websocket.close(code=UNAVAILABLE)
        return
    try:
        await websocket.accept(subprotocol=frames.SUBPROTOCOL)
    except RuntimeError, OSError:
        registry.REGISTRY.remove(socket.handle)
        return
    await socket.serve()
