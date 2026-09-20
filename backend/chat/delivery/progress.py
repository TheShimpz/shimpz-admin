"""Ordered worker-to-WebSocket progress delivery for Admin chat."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
from collections.abc import Awaitable, Callable, Mapping

from chat import local

ProgressQueue = asyncio.Queue[dict[str, object]]
ProgressReporter = Callable[[dict[str, object]], None]
SendEvent = Callable[[Mapping[str, object]], Awaitable[bool]]


def _enqueue(queue: ProgressQueue, value: dict[str, object]) -> None:
    try:
        event = local.canonical_public_progress(value)
    except ValueError:
        return
    with contextlib.suppress(asyncio.QueueFull):
        queue.put_nowait(event)


def channel() -> tuple[ProgressQueue, ProgressReporter]:
    """Return one bounded queue and its thread-safe worker reporter."""
    progress: ProgressQueue = asyncio.Queue(maxsize=local.MAX_PUBLIC_PROGRESS_EVENTS)
    loop = asyncio.get_running_loop()

    def report(event: dict[str, object]) -> None:
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(_enqueue, progress, event)

    return progress, report


async def _deliver_event(
    send_event: SendEvent,
    mark_closed: Callable[[], None],
    response: asyncio.Future,
    event: Mapping[str, object],
) -> tuple[bool, object | None]:
    if await send_event(event):
        return True, None
    mark_closed()
    # The worker schedules each progress callback before completing its Future. Let the completion
    # callback already queued behind this delivery run before deciding whether the still-active
    # operation must be stopped.
    await asyncio.sleep(0)
    return False, await response if response.done() else None


async def await_result(
    future: concurrent.futures.Future,
    progress: ProgressQueue,
    inactive: Callable[[], bool],
    send_event: SendEvent,
    mark_closed: Callable[[], None],
) -> object | None:
    """Deliver ordered progress before returning the worker's terminal result."""
    response = asyncio.wrap_future(future)
    pending_progress: asyncio.Task[dict[str, object]] | None = None
    sequence = 0
    try:
        while not response.done():
            pending_progress = asyncio.create_task(progress.get())
            completed, _pending = await asyncio.wait(
                {response, pending_progress},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if pending_progress in completed:
                event = pending_progress.result()
                pending_progress = None
                if inactive():
                    return None
                sequence += 1
                delivered, result = await _deliver_event(
                    send_event,
                    mark_closed,
                    response,
                    {"type": "progress", "seq": sequence, **event},
                )
                if not delivered:
                    return result
                continue
            with contextlib.suppress(asyncio.CancelledError):
                pending_progress.cancel()
                await pending_progress
            pending_progress = None
        if inactive():
            return None
        # The worker can complete before the event loop materializes its final thread-safe callback.
        # Yield once at that ordered boundary before draining progress ahead of the terminal result.
        await asyncio.sleep(0)
        while not progress.empty():
            if inactive():
                return None
            event = progress.get_nowait()
            sequence += 1
            delivered, result = await _deliver_event(
                send_event,
                mark_closed,
                response,
                {"type": "progress", "seq": sequence, **event},
            )
            if not delivered:
                return result
        return await response
    finally:
        if pending_progress is not None:
            pending_progress.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pending_progress
