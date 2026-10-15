"""Ordered worker-to-WebSocket progress delivery for Admin chat."""

import asyncio
import concurrent.futures
import contextlib
from collections.abc import Awaitable, Callable, Mapping

from chat.connection import Receipt

from chat import local

ProgressQueue = asyncio.Queue[dict[str, object]]
ProgressReporter = Callable[[dict[str, object]], None]
SendEvent = Callable[[Mapping[str, object]], Awaitable[bool]]
RecordEvent = Callable[[Mapping[str, object]], None]


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


def receipt_delivery(receipt: Receipt, turn_id: str | None, *, fresh: bool) -> RecordEvent:
    """Begin one progress delivery of ``turn_id``'s receipt and return what records each frame the browser received.

    A Team turn's own delivery begins its receipt afresh, as the page does for a sent message; a continuation adds to
    the receipt of the same history turn, and one of another turn begins its own.
    """
    if fresh or receipt.turn_id != turn_id:
        receipt.turn_id = turn_id
        receipt.deliveries = 0
        receipt.events = []
    delivery = receipt.deliveries
    receipt.deliveries += 1
    events = receipt.events

    def record(frame: Mapping[str, object]) -> None:
        # Admin's own steps run outside Team's clock and never enter a receipt. One more than the bound is kept, so a
        # receipt that outgrew it is known and left out.
        if frame.get("origin") == "team" and len(events) <= local.MAX_PUBLIC_PROGRESS_EVENTS:
            events.append({"segment": delivery, **{key: value for key, value in frame.items() if key != "type"}})

    return record


def take_receipt(receipt: Receipt, turn_id: str | None) -> list[dict[str, object]] | None:
    """End the logical turn's receipt and return it for ``turn_id``'s reply, or None when there is none to keep.

    Its deliveries are numbered in order from 0 among those that delivered a Team step. A receipt of another turn, an
    empty one, and one that outgrew its bound are not kept.
    """
    owner, events = receipt.turn_id, receipt.events
    receipt.turn_id = None
    receipt.deliveries = 0
    receipt.events = []
    if turn_id is None or owner != turn_id or not events or len(events) > local.MAX_PUBLIC_PROGRESS_EVENTS:
        return None
    numbers: dict[object, int] = {}
    for event in events:
        numbers.setdefault(event["segment"], len(numbers))
    return [{**event, "segment": numbers[event["segment"]]} for event in events]


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
