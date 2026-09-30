"""Admin's Routine scheduler (ADR-0086): one thread claims due runs onto a lane of two workers.

Every tick, with jitter, it delivers notices, then reserves a free lane slot before it asks Team to claim, so a lease
is never taken for a run no worker can start. Team enforces every lease and deadline itself, so a stalled worker only
wastes its own slot.
"""

from __future__ import annotations

import logging
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

import state
import supervisor
from history import store as history

from routine import delivery, team

INTERVAL_SECONDS = 30
JITTER_SECONDS = 5
WORKERS = 2
_FAILURES = (team.RoutineTeamError, history.HistoryUnavailableError, supervisor.SupervisorAuthorityError, OSError)

log = logging.getLogger("shimpz.admin.routine")


class RoutineScheduler:
    def __init__(self, *, interval: float = INTERVAL_SECONDS, jitter: float = JITTER_SECONDS, workers: int = WORKERS):
        self._interval = interval
        self._jitter = jitter
        self._stop = threading.Event()
        self._slots = threading.BoundedSemaphore(workers)
        self._workers = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="shimpz-routine-run")
        self._thread = threading.Thread(target=self._loop, name="shimpz-routine-scheduler", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=10)
        self._workers.shutdown(wait=False, cancel_futures=True)

    def _loop(self) -> None:
        while not self._stop.wait(self._interval + secrets.randbelow(int(self._jitter * 1000) + 1) / 1000):
            try:
                self.tick()
            except Exception:
                # Any other failure, such as an unreadable credential store, is retried; the thread never dies.
                log.exception("Routine scheduler tick failed; retrying on the next tick")

    def tick(self) -> None:
        """Deliver notices, then start at most one due run; a failure waits for the next tick."""
        try:
            delivery.deliver()
        except _FAILURES:
            log.warning("Routine notice delivery failed; retrying on the next tick")
        try:
            self._start()
        except _FAILURES:
            log.warning("Routine claim failed; retrying on the next tick")

    def _start(self) -> None:
        if not self._slots.acquire(blocking=False):
            return
        started = False
        try:
            # The identity and its public key exist before any lease is taken for them.
            identity = state.local_routine_identity()
            supervisor.materialize_routine_key(identity)
            held = team.providers()
            claimed = team.claim(held) if held else None
            if claimed is not None:
                self._workers.submit(self._run, claimed, identity)
                started = True
        finally:
            if not started:
                self._slots.release()

    def _run(self, claimed: dict[str, object], identity: supervisor.LocalIdentity) -> None:
        try:
            outcome = team.run(claimed, identity)
            log.info("Routine run ended %s", outcome)
        except _FAILURES:
            log.warning("Routine run segment failed; Team ends the run under its own lease rules")
        finally:
            self._slots.release()
