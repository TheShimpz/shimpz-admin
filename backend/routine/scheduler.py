"""Admin's Routine scheduler (ADR-0086): one thread claims due runs onto a lane of two workers.

Every tick, with jitter, it delivers notices, then reserves a free lane slot before it asks Team to claim, so a lease
is never taken for a run no worker can start. Team enforces every lease and deadline itself, so a stalled worker only
wastes its own slot. A tick comes at the latest every interval; Team's next-due hint and a finished run wake it sooner
(ADR-0092), and a missed hint only waits for the next reconciliation.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import state
import supervisor
from history import store as history

from routine import delivery, team

INTERVAL_SECONDS = 30
JITTER_SECONDS = 5
# The earliest a hint or a finished run wakes the next tick, so a busy Team is never polled in a tight loop.
MIN_WAKE_SECONDS = 1
WORKERS = 2
_FAILURES = (team.RoutineTeamError, history.HistoryUnavailableError, supervisor.SupervisorAuthorityError, OSError)

log = logging.getLogger("shimpz.admin.routine")


class RoutineScheduler:
    def __init__(self, *, interval: float = INTERVAL_SECONDS, jitter: float = JITTER_SECONDS, workers: int = WORKERS):
        self._interval = interval
        self._jitter = jitter
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._due_at: float | None = None
        self._slots = threading.BoundedSemaphore(workers)
        self._workers = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="shimpz-routine-run")
        self._thread = threading.Thread(target=self._loop, name="shimpz-routine-scheduler", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread.is_alive():
            self._thread.join(timeout=10)
        self._workers.shutdown(wait=False, cancel_futures=True)

    def delay(self, now: float) -> float:
        """Seconds until the next tick: the reconciliation interval with jitter, or sooner for a hinted due run."""
        delay = self._interval + secrets.randbelow(int(self._jitter * 1000) + 1) / 1000
        if self._due_at is not None:
            delay = min(delay, max(MIN_WAKE_SECONDS, self._due_at - now))
        return delay

    def _loop(self) -> None:
        while True:
            self._wake.wait(self.delay(time.time()))
            self._wake.clear()
            if self._stop.is_set():
                return
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
            answer = team.claim(held) if held else {"run": None, "next_due_at": None}
            claimed = answer["run"]
            self._due_at = answer["next_due_at"]
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
            # A finished run frees a slot and may make the next one due: claim again soon, not at the next interval.
            self._due_at = time.time()
            self._wake.set()
