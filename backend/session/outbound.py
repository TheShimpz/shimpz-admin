"""The bounded outbound queue of one Admin session socket (ADR-0114 decision 8).

Results and chat frames are never dropped. A change notice is an invalidation only, so a newer one for the same topic
replaces the one still queued: the client re-reads the current state either way. More than the queue bound waiting to
be written closes the socket, and the client re-reads after reconnecting.
"""

import asyncio
from collections import deque

from protocol.socket.v1 import frames


class OutboundOverflowError(RuntimeError):
    """The socket's queued outbound bytes exceeded their bound."""


class Outbound:
    def __init__(self, limit: int = frames.MAX_QUEUED_BYTES) -> None:
        self._limit = limit
        # Each item is [text, topic or None]; a queued change notice is replaced in place by a newer one.
        self._items: deque[list] = deque()
        self._changes: dict[str, list] = {}
        self._queued = 0
        self._ready = asyncio.Event()
        self.closed = False

    @property
    def queued(self) -> int:
        return self._queued

    def put(self, text: str, *, topic: str | None = None) -> None:
        """Queue one serialized frame; a change notice coalesces with the one still queued for its topic."""
        if self.closed:
            raise RuntimeError("the session socket is closed")
        size = len(text.encode("utf-8"))
        queued = self._changes.get(topic) if topic is not None else None
        if queued is not None:
            self._queued += size - len(queued[0].encode("utf-8"))
            queued[0] = text
        else:
            item = [text, topic]
            self._items.append(item)
            if topic is not None:
                self._changes[topic] = item
            self._queued += size
        if self._queued > self._limit:
            raise OutboundOverflowError("the session socket's outbound queue is full")
        self._ready.set()

    async def take(self) -> str:
        """Wait for the next frame to write."""
        while not self._items:
            self._ready.clear()
            await self._ready.wait()
        text, topic = self._items.popleft()
        if topic is not None:
            self._changes.pop(topic, None)
        self._queued -= len(text.encode("utf-8"))
        return text
