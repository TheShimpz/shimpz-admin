"""The one process-wide watcher of state Admin cannot observe itself (ADR-0114 decision 4).

Teams made by the CLI, Assistant snapshots the CLI stages, and the platform release file change
without passing through Admin. While
at least one open socket subscribes to such a topic, and only then, the watcher reads it no more often than the page
used to poll it, under the current Supervisor authority of a socket whose session is still current (never renewing
it), and raises the topic when its first sample is taken and afterwards only when the value changed.
"""

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

import supervisor
from fastapi import HTTPException
from session import registry, topics
from space import release as platform_release
from team import bridge as team
from team import order as team_order

log = logging.getLogger("shimpz-admin")


def _seen(status: int, body: dict[str, object]) -> object:
    """A watched answer as the page sees it: Team's per-request trace identifier is never part of a change."""
    return status, {field: value for field, value in body.items() if field != "trace_id"}


def _teams() -> object:
    response = team_order.listing()
    return _seen(response.status_code, json.loads(response.body))


def _snapshots() -> object:
    response = team.list_local_assistants()
    return _seen(response.status, response.body)


def _release() -> object:
    try:
        return platform_release.read_status()
    except platform_release.PlatformReleaseUnavailableError:
        return None


@dataclass(frozen=True, slots=True)
class Watched:
    interval: float
    read: Callable[[], object]
    # Whether reading needs a Supervisor's authority (a Team read) or not (a local file).
    authority: bool = True


# Each watched topic and how often it was polled before the socket; the Team list and the staged snapshots, which no
# page polled, at the slowest of those intervals.
WATCHED = {
    "platform/release": Watched(60.0, _release, authority=False),
    "teams": Watched(60.0, _teams),
    "local-assistants": Watched(60.0, _snapshots),
}
# How often the watcher wakes to see whether a watched topic is due.
TICK_SECONDS = 1.0


class Watcher:
    def __init__(self, watched: dict[str, Watched] = WATCHED, *, tick: float = TICK_SECONDS) -> None:
        self._watched = watched
        self._tick = tick
        self._task: asyncio.Task | None = None
        self._values: dict[str, object] = {}
        self._due: dict[str, float] = {}

    def _subscribers(self, topic: str) -> list[registry.Handle]:
        return [handle for handle in registry.REGISTRY.handles() if handle.subscribed(topic)]

    def refresh(self) -> None:
        """Run while a socket subscribes to a watched topic; stop, forgetting every value, once none does."""
        needed = any(self._subscribers(topic) for topic in self._watched)
        running = self._task is not None and not self._task.done()
        if needed and not running:
            self._values.clear()
            self._due.clear()
            self._task = asyncio.get_running_loop().create_task(self._run())
        elif not needed and running:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        while True:
            for topic, watched in self._watched.items():
                if time.monotonic() >= self._due.get(topic, 0.0):
                    await self._check(topic, watched)
            await asyncio.sleep(self._tick)

    async def _authority(self, topic: str) -> registry.Handle | None:
        """A subscriber whose session is current now; checking it never counts as Supervisor activity."""
        for handle in self._subscribers(topic):
            if await registry.session_status(handle.current, handle.cookies) == "active":
                return handle
        return None

    async def _check(self, topic: str, watched: Watched) -> None:
        handle = await self._authority(topic)
        if handle is None:
            return
        self._due[topic] = time.monotonic() + watched.interval
        try:
            with handle.scope() if watched.authority else contextlib.nullcontext():
                value = await asyncio.to_thread(watched.read)
        except (team.TeamRequestError, supervisor.SupervisorAuthorityError, HTTPException, OSError) as exc:
            log.warning("session watcher could not read %s (%s)", topic, type(exc).__name__)
            return
        # The first sample is announced too: a change made after a page's own read and before this sample would
        # otherwise become the silent baseline, and the page would keep showing the older value.
        if topic not in self._values or self._values[topic] != value:
            topics.changed(topic)
        self._values[topic] = value


WATCHER = Watcher()
