"""Session-scoped admission budgets of the Admin session socket (ADR-0114 decision 8).

Budgets belong to the session, never to one socket, so reconnecting never replenishes them. Each counts admitted
events in a sliding minute.
"""

import threading
import time
from collections import deque
from collections.abc import Callable

WINDOW_SECONDS = 60.0
# Per session per minute: socket opens; calls; and subscribe, unsubscribe, attach, and detach changes.
SOCKET_OPENS = 30
CALLS = 600
CHANGES = 120


class SessionBudget:
    """One sliding-window budget per session digest."""

    def __init__(self, limit: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit
        self._clock = clock
        self._lock = threading.Lock()
        self._events: dict[str, deque[float]] = {}

    def admit(self, session: str) -> bool:
        """Count one event for the session, or refuse it once its minute is spent."""
        now = self._clock()
        with self._lock:
            for key in [key for key, events in self._events.items() if now - events[-1] >= WINDOW_SECONDS]:
                del self._events[key]
            events = self._events.setdefault(session, deque())
            while events and now - events[0] >= WINDOW_SECONDS:
                events.popleft()
            if len(events) >= self._limit:
                return False
            events.append(now)
            return True


class SessionRenewals:
    """When each session's idle time last restarted, so activity frames from its other tabs meanwhile change nothing."""

    def __init__(self, interval: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._interval = interval
        self._clock = clock
        self._lock = threading.Lock()
        self._renewed: dict[str, float] = {}

    def due(self, session: str) -> bool:
        """Whether the session's idle time may restart now; a restart that is due is counted at once."""
        now = self._clock()
        with self._lock:
            for key in [key for key, at in self._renewed.items() if now - at >= self._interval]:
                del self._renewed[key]
            if session in self._renewed:
                return False
            self._renewed[session] = now
            return True


# The shortest time between two restarts of one session's idle time; each tab reports input at most once a minute.
RENEWAL_SECONDS = 30.0

OPENS = SessionBudget(SOCKET_OPENS)
CALL_BUDGET = SessionBudget(CALLS)
CHANGE_BUDGET = SessionBudget(CHANGES)
RENEWALS = SessionRenewals(RENEWAL_SECONDS)
