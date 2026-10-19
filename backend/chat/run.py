"""Each Team's chat run in Admin (ADR-0119): the run that outlives its pages, the pages that watch it, and its ending.

A run dispatches its Team's `shimpz.chat.v7` frames through :mod:`chat.socket` one at a time, each under the
Supervisor authority it was admitted with; closing a page only stops watching. Only Stop, a revoked authority, the
Team's deletion, or a Space reset ends a run's work.
"""

import asyncio
import concurrent.futures
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import supervisor as local_supervisor
from chat.connection import Connection, Turn
from chat.delivery import gated
from chat.projection import error_terminal, stop_accepted
from fastapi import WebSocketDisconnect
from history import delivery as history_delivery
from signin import auth
from team import transport

from chat import human
from chat import socket as chat_socket

# The frames one Team's run may hold while an earlier one dispatches; a page sends one at a time, and Stop.
MAX_WAITING_FRAMES = 8
log = logging.getLogger("shimpz-admin")


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


class FrameRelay(Relay):
    """What one frame's dispatch writes to (ADR-0119).

    While the frame is dispatched, a refusal reaches only the page that sent it; everything its started work sends
    afterwards reaches every page that watches.
    """

    def __init__(self, run: Run, observer: Transport | None) -> None:
        super().__init__(run)
        self.observer = observer
        self.dispatching = True

    async def send_json(self, event: dict[str, object]) -> None:
        if self.dispatching and event.get("type") == "error" and self.observer is not None:
            self.run.push(self.observer, event)
            return
        await super().send_json(event)


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
        self._frames: asyncio.Queue[tuple[dict[str, object], Authority, Transport | None]] = asyncio.Queue()
        self._ending = False
        # A frame is being dispatched now: from its dequeue until it either started work or was refused.
        self._dispatching = False
        self._task = asyncio.create_task(self._loop())

    # Pages

    def attach(self, observer: Transport, authority: Authority, locale: str) -> None:
        """Let one more page watch; a busy run shows it where it is, an idle one synchronizes as a fresh page does."""
        self.observers.add(observer)
        if self.busy():
            self.push(observer, self.snapshot())
        else:
            self.submit({"type": "sync", "locale": locale}, authority, observer)

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
            self._dispatching
            or connection.active is not None
            or connection.sync_task is not None
            or connection.lifecycle is not None
            or not self._frames.empty()
        )

    def snapshot(self) -> dict[str, object]:
        """Where the run is now, as one `running` event.

        It says how long the run has run, its queue place, the sequence number of its delivery's latest step (`cursor`,
        which the next step follows), and its latest steps.
        """
        elapsed = 0 if self.started is None else int((time.monotonic() - self.started) * 1000)
        cursor = self.live[-1]["seq"] if self.live else 0
        return {
            "type": "running",
            "elapsed_ms": max(0, elapsed),
            "position": self.position,
            "cursor": cursor,
            "events": list(self.live),
        }

    def publish(self, event: dict[str, object]) -> None:
        """Record what a page attaching later must see, then hand the event to every page attached now."""
        kind = event.get("type")
        if kind == "progress":
            if event.get("seq") == 1:
                self.live = []
            # Only the latest steps are kept: a page that attaches is shown them and continues from the last one.
            self.live.append(dict(event))
            del self.live[:-LIVE_STEPS]
        elif kind == "running":
            position = event.get("position")
            self.position = position if isinstance(position, int) else None
        for observer in tuple(self.observers):
            self.push(observer, event)

    def push(self, observer: Transport, event: dict[str, object]) -> None:
        """Hand one event to one page; a page that cannot take it stops watching."""
        try:
            observer.push(dict(event))
        except RuntimeError, ValueError, OSError:
            # An overflowing or closed socket, or a frame it cannot carry: that page stops watching.
            self.observers.discard(observer)

    # Frames

    def submit(self, frame: dict[str, object], authority: Authority, observer: Transport | None = None) -> bool:
        """Queue one admitted chat frame with the authority it was admitted under; refuse one beyond the bound.

        A run that is ending tells the page that sent the frame to send it again once it ended.
        """
        if self.connection.closed:
            if observer is not None:
                self.push(observer, error_terminal(409, "the Team's chat is ending; send again in a moment"))
            return True
        if self._frames.qsize() >= MAX_WAITING_FRAMES:
            return False
        self._frames.put_nowait((frame, authority, observer))
        return True

    async def _loop(self) -> None:
        try:
            while True:
                frame, authority, observer = await self._frames.get()
                self._dispatching = True
                try:
                    if not await authority.current():
                        # Its session or Origin ended before its turn came: it runs nothing.
                        continue
                    await self._run_frame(frame, authority, observer)
                finally:
                    self._dispatching = False
        except WebSocketDisconnect:
            # A protocol refusal closed the pages; the run's work ends with them, as Stop would end it.
            asyncio.get_running_loop().create_task(self.end())

    async def _run_frame(self, frame: dict[str, object], authority: Authority, observer: Transport | None) -> None:
        """Dispatch one frame; the work it starts, and only that, runs under its authority and is watched afresh."""
        connection = self.connection
        before = (connection.active, connection.sync_task, connection.lifecycle)
        relay = FrameRelay(self, observer)
        try:
            with authority.scope():
                await chat_socket.dispatch(relay, connection, self.team_id, frame, authority.authenticate)
        except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
            # The current Supervisor authority is unavailable: the frame is refused as the HTTP gate refuses.
            log.warning("chat run frame refused: Supervisor authority is unavailable")
            await relay.send_json(error_terminal(503, "Supervisor authority is unavailable"))
        finally:
            relay.dispatching = False
        after = (connection.active, connection.sync_task, connection.lifecycle)
        if any(now is not None and now is not then for now, then in zip(after, before, strict=True)):
            # The work it started has not run yet: it is watched from its first step.
            self.authority = authority
            self.live, self.started, self.position = [], time.monotonic(), None

    # Ending

    def retire(self) -> None:
        """Forget an idle run nobody watches; Team keeps any pending request, which a page's sync restores."""
        if RUNS.get(self.team_id) is self:
            del RUNS[self.team_id]
        self._task.cancel()

    async def end(self) -> None:
        """Stop the run's work, keep how its turn ended, and forget the run (revocation, deletion, reset).

        The run stays the Team's until its work is proven stopped, so no new run starts beside work still ending; its
        pages then follow the Team's next run.
        """
        if self._ending:
            return
        # From here no frame is admitted: a page that sends one is told to send it again once the run ended.
        self._ending = True
        self.connection.closed = True
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        active = self.connection.active
        unfinished = None if active is None or active.terminal_sent else active.history_id
        # A human or Integration continuation Team executes now is stopped there too, not only no longer awaited.
        continuing = self.connection.continuing
        continuation = self.connection.continuation
        authority = self.authority
        # The status of the run's own Stop when Team did not confirm it.
        unconfirmed: int | None = None
        try:
            with authority.scope() if authority is not None else contextlib.nullcontext():
                await chat_socket.close_connection(self.relay, self.connection, self.team_id)
                # Admin holds no Team answer that ended its turn, so the Team may still run it: stop it there too.
                if continuing or (active is not None and not active.terminal_sent and active.stop_task is None):
                    response = await chat_socket.team_stop(self.team_id)
                    if stop_accepted(response, self.team_id) is None:
                        unconfirmed = chat_socket.stop_status(response)
        except transport.TeamRequestError, local_supervisor.SupervisorAuthorityError, RuntimeError:
            log.warning("chat run ended without Supervisor authority")
            await chat_socket.close_connection(self.relay, self.connection, self.team_id)
            unconfirmed = 503
        # The Team is released only once its work and every Stop sent for it ended, so neither reaches a later turn,
        # and its turn's ending is known only then.
        await _ended(active, continuation)
        if unfinished is not None:
            unconfirmed = unconfirmed or active.stop_unconfirmed
            # A Stop Team did not confirm is never shown as stopped: its turn may still run, and stays resumable.
            ending = {"type": "stopped"} if unconfirmed is None else chat_socket.unstopped(unconfirmed)
            with contextlib.suppress(Exception):
                await history_delivery.terminal(self.team_id, unfinished, ending, finish_history=unconfirmed is None)
            self.publish(ending)
        if RUNS.get(self.team_id) is self:
            del RUNS[self.team_id]


async def _ended(active: Turn | None, continuation: concurrent.futures.Future | None) -> None:
    """Wait until a run's Team call, its continuation, and the Stop sent for them have all ended."""
    waits: list[Awaitable[object]] = []
    if active is not None and active.future is not None and not active.future.done():
        waits.append(asyncio.wrap_future(active.future))
    if active is not None and active.stop_task is not None and not active.stop_task.done():
        waits.append(active.stop_task)
    if continuation is not None and not continuation.done():
        waits.append(asyncio.wrap_future(continuation))
    await asyncio.gather(*waits, return_exceptions=True)


# The latest steps of a run's delivery a page that attaches is shown.
LIVE_STEPS = 64
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


# Runs being ended, each on its own task so one whose Team never answers holds up no other.
_ENDINGS: set[asyncio.Task] = set()


def _end_apart(run: Run) -> None:
    task = asyncio.get_running_loop().create_task(run.end())
    _ENDINGS.add(task)
    task.add_done_callback(_ENDINGS.discard)


def end_runs(team_id: str | None = None) -> None:
    """End one Team's run, or every run: its Team was deleted, or the Space reset (on the event loop)."""
    for run in [run for key, run in RUNS.items() if team_id is None or key == team_id]:
        _end_apart(run)


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
            _end_apart(run)


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
                    _end_apart(run)
            elif not run.observers:
                run.retire()


class Channel:
    """One page watching one Team's chat run over its session socket (ADR-0114, ADR-0119).

    Its frames run on the Team's current run under the authority they were admitted with; closing it stops watching,
    never the work. Once a run ended, the page follows the Team's next one.
    """

    def __init__(self, transport: Transport, team_id: str, authority: Callable[[], Authority]) -> None:
        self.transport = transport
        self.team_id = team_id
        self._authority = authority

    @property
    def run(self) -> Run:
        run = run_for(self.team_id)
        if not run.connection.closed:
            run.observers.add(self.transport)
        return run

    @property
    def connection(self) -> Connection:
        return self.run.connection

    def attach(self, locale: str) -> None:
        run = run_for(self.team_id)
        run.attach(self.transport, self._authority(), locale)

    def submit(self, frame: dict[str, object]) -> bool:
        """Queue one admitted chat frame for the Team's run in arrival order; refuse one beyond the waiting bound."""
        return self.run.submit(frame, self._authority(), self.transport)

    def halt(self) -> None:
        """Stop watching at once: the socket is closing."""
        run = RUNS.get(self.team_id)
        if run is not None:
            run.detach(self.transport)

    async def close(self) -> None:
        """Stop watching; the run's work goes on (ADR-0119)."""
        self.halt()


auth.SESSIONS.listen(sessions_ended)
