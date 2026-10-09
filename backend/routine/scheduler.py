"""Admin's Routine scheduler (ADR-0086): one thread claims due runs onto a lane of two workers.

Every tick, with jitter, it delivers notices, then reserves a free lane slot before each claim, so a lease is never
taken for a run no worker can start, and it claims until every slot is busy or Team has nothing more to start. At most
one worker holds a long run, so a long run never keeps short work from every worker: a claim offers to take a long run
only while that one long slot is free (ADR-0092 amendment, 2026-10-05, scale). Team
enforces every lease and deadline itself, so a stalled worker only wastes its own slot. A tick comes at the latest
every interval; Team's next-due hint and a finished run wake it sooner (ADR-0092), and a missed hint only waits for
the next reconciliation.
"""

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
        self._long = threading.Lock()
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

    def wake(self) -> None:
        """Claim soon: a person's Rodar made a Routine due now."""
        self._due_at = time.time()
        self._wake.set()

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
        """Fill every free lane slot with a due run, one claim per slot, until Team has nothing more to start.

        The hint kept is the one Team gave when it had nothing more to start. When every slot is busy no hint is kept:
        nothing can start until a run finishes, and a finished run wakes the next tick, which claims and asks again.
        """
        held = self._slots.acquire(blocking=False)
        if not held:
            return
        try:
            # The identity and its public key exist before any lease is taken for them.
            identity = state.local_routine_identity()
            supervisor.materialize_routine_key(identity)
            # Until Team answers with nothing more to start, only a run finishing meanwhile sets the next wake.
            self._due_at = None
            while held:
                claimed, long = self._claim()
                if claimed is None:
                    return
                self._workers.submit(self._run, claimed, identity, long)
                # The slot, and the long slot for a long run, are now the run's own; the worker frees them.
                held = self._slots.acquire(blocking=False)
        finally:
            if held:
                self._slots.release()

    def _claim(self) -> tuple[dict[str, object] | None, bool]:
        """Claim one run, offering a long one only while the long slot is free; also say whether it keeps that slot.

        Team leasing a long run Admin did not offer to take is refused, so two long runs never share the workers.
        """
        reserved = self._long.acquire(blocking=False)
        kept = False
        try:
            answer = team.claim(reserved)
            claimed = answer["run"]
            if claimed is None:
                self._due_at = answer["next_due_at"]
                return None, False
            kept = team.is_long(claimed)
            if kept and not reserved:
                raise team.RoutineTeamError("Team leased a long run Admin could not take")
            return claimed, kept
        finally:
            if reserved and not kept:
                self._long.release()

    def _run(self, claimed: dict[str, object], identity: supervisor.LocalIdentity, long: bool) -> None:
        try:
            outcome = team.run(claimed, identity)
            log.info("Routine run ended %s", outcome)
        except _FAILURES:
            log.warning("Routine run segment failed; Team ends the run under its own lease rules")
        finally:
            if long:
                self._long.release()
            self._slots.release()
            # A finished run frees a slot and may make the next one due: claim again soon, not at the next interval.
            self._due_at = time.time()
            self._wake.set()
