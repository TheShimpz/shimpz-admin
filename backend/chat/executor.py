"""Bounded context-preserving worker admission for local chat responsibilities."""

from __future__ import annotations

import concurrent.futures
import contextvars
import threading


class ExecutorSaturatedError(RuntimeError):
    """The worker and queue budget has no free admission slot."""


class BoundedThreadPoolExecutor(concurrent.futures.ThreadPoolExecutor):
    """Thread pool with a non-blocking bound across running and queued work."""

    def __init__(self, *, max_workers: int, max_outstanding: int, thread_name_prefix: str) -> None:
        if max_workers < 1 or max_outstanding < max_workers:
            raise ValueError("invalid bounded executor capacity")
        self._permits = threading.BoundedSemaphore(max_outstanding)
        super().__init__(max_workers=max_workers, thread_name_prefix=thread_name_prefix)

    def submit(self, fn, /, *args, **kwargs):
        if not self._permits.acquire(blocking=False):
            raise ExecutorSaturatedError("blocking worker admission is full")
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self._permits.release()
            raise
        future.add_done_callback(lambda _completed: self._permits.release())
        return future


def submit_in_context(executor, function, /, *args, **kwargs):
    """Submit work with the current request context copied into its worker."""
    context = contextvars.copy_context()
    return executor.submit(context.run, function, *args, **kwargs)
