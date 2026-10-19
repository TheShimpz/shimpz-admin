"""The Space's chat execution gate (ADR-0119): at most the Space's limit of chat operations run at once.

Team owns the limit and refuses a turn beyond it in the same step that registers the turn, so this gate only shapes
the wait: an operation takes a slot before it starts, and the rest wait in one first-in, first-out queue, each told
its position as it moves. Nothing runs while waiting, and a Team answer that the Space is still busy (work Admin does
not know of, such as a turn an earlier Admin process started) puts the operation back at the head of the queue.
Stop never waits here: cancelling a waiting operation leaves the queue at once. The gate lives on Admin's event loop.
"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

# The operations that may wait at once, across the Space; one more is refused rather than queued.
MAX_WAITING = 32
# How long an operation Team found the Space busy for waits before it asks again.
BUSY_RETRY_SECONDS = 2.0

# Told the operation's place in the queue (1 is next), or None once it runs.
Position = Callable[[int | None], None]
# Team's current limit, read in the context of the operation that needs it.
ReadLimit = Callable[[], Awaitable[int]]


class QueueFullError(RuntimeError):
    """As many operations as the queue holds already wait."""


@dataclass(eq=False, slots=True)
class _Held:
    """One operation's hold on the gate."""

    gate: Gate
    position: Position
    read_limit: ReadLimit
    holding: bool = False

    async def busy(self) -> None:
        """Team found the Space busy: give the slot back, wait a moment, and take one again at the head of the queue.

        While it waits it still counts against the queue's bound, so retrying operations never let the queue outgrow it.
        """
        self.release()
        self.gate._resting += 1
        try:
            await asyncio.sleep(BUSY_RETRY_SECONDS)
        except asyncio.CancelledError:
            # Stopped while it rested: the place it kept goes to whoever waits.
            self.gate._resting -= 1
            self.gate._grant()
            raise
        self.gate._resting -= 1
        await self.gate._acquire(self.position, self.read_limit, head=True)
        self.holding = True

    def release(self) -> None:
        """Give the slot back once; a hold that already gave it back (a busy wait Stop cut short) gives nothing."""
        if not self.holding:
            return
        self.holding = False
        self.gate._release()


@dataclass(eq=False, slots=True)
class _Waiter:
    position: Position
    granted: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    # The place it was last told; only a change is told again.
    place: int | None = None


class Gate:
    def __init__(self) -> None:
        self._limit: int | None = None
        self._running = 0
        self._waiting: list[_Waiter] = []
        # Operations Team found the Space busy for, waiting a moment before they queue again at the head.
        self._resting = 0
        # Operations waiting for Team's first answer of the limit, all on one shared read.
        self._reading = 0
        self._limit_read: asyncio.Future | None = None

    @property
    def limit(self) -> int | None:
        return self._limit

    def set_limit(self, limit: int) -> None:
        """Team answered its current limit: a higher one starts waiting operations; a lower one lets running drain."""
        self._limit = limit
        self._grant()

    @contextlib.asynccontextmanager
    async def slot(self, position: Position, read_limit: ReadLimit):
        """Hold one slot for the body; wait for it first, in order, when the Space runs as many as its limit."""
        held = _Held(self, position, read_limit)
        await self._acquire(position, read_limit, head=False)
        held.holding = True
        try:
            yield held
        finally:
            held.release()

    def _queued(self) -> int:
        """Every operation that waits for a slot: queued, resting after a busy Space, or waiting for the limit."""
        return len(self._waiting) + self._resting + self._reading

    async def _read_limit(self, read_limit: ReadLimit) -> None:
        """Read Team's limit once for every operation that needs it first; a failed read is tried again by the next."""
        if self._queued() >= MAX_WAITING:
            raise QueueFullError("the chat queue is full")
        self._reading += 1
        try:
            if self._limit_read is None:
                read = asyncio.ensure_future(read_limit())
                read.add_done_callback(self._limit_answered)
                self._limit_read = read
            # A reader Stop cancels leaves the shared read to the others; its answer is kept before any reader resumes.
            await asyncio.shield(self._limit_read)
        finally:
            self._reading -= 1

    def _limit_answered(self, read: asyncio.Future) -> None:
        """The shared read ended: keep its answer, or forget a failure so the next operation reads again."""
        self._limit_read = None
        if not read.cancelled() and read.exception() is None and self._limit is None:
            self._limit = read.result()

    async def _acquire(self, position: Position, read_limit: ReadLimit, *, head: bool) -> None:
        if self._limit is None:
            await self._read_limit(read_limit)
        # A free slot goes at once only to an operation nobody waits ahead of, resting ones included.
        if not self._waiting and not (self._resting and not head) and self._running < self._limit:
            self._running += 1
            position(None)
            return
        if not head and self._queued() >= MAX_WAITING:
            raise QueueFullError("the chat queue is full")
        waiter = _Waiter(position)
        if head:
            self._waiting.insert(0, waiter)
        else:
            self._waiting.append(waiter)
        # A slot left free for a resting operation goes to the head once it is back, or to whoever waits once none
        # rests any more.
        if not self._resting:
            self._grant()
        self._tell()
        try:
            await waiter.granted
        except asyncio.CancelledError:
            if waiter.granted.done() and not waiter.granted.cancelled():
                # Granted as it was cancelled: the slot it took goes to the next waiter.
                self._release()
            else:
                self._waiting.remove(waiter)
                self._tell()
            raise
        position(None)

    def _release(self) -> None:
        self._running -= 1
        self._grant()

    def _grant(self) -> None:
        limit = self._limit or 0
        granted = False
        while self._waiting and self._running < limit:
            waiter = self._waiting.pop(0)
            self._running += 1
            waiter.granted.set_result(None)
            granted = True
        if granted:
            self._tell()

    def _tell(self) -> None:
        for place, waiter in enumerate(self._waiting, start=1):
            if waiter.place != place:
                waiter.place = place
                waiter.position(place)


GATE = Gate()
