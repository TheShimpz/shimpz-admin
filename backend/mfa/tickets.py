"""Bounded one-use password tickets and WebAuthn challenges."""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

TICKET_TTL_SECONDS = 180
TICKET_CAPACITY = 64


class TicketError(RuntimeError):
    """A password ticket is invalid, expired, reused, or unavailable."""


@dataclass(frozen=True, slots=True)
class Ticket:
    """Private evidence binding password verification to one second-factor attempt."""

    purpose: str
    origin: str | None
    generation: int
    expires_at: float


class TicketStore:
    """One-process, bounded, one-use ticket authority."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        capacity: int = TICKET_CAPACITY,
        ttl_seconds: int = TICKET_TTL_SECONDS,
    ) -> None:
        if not 1 <= capacity <= 1024 or not 30 <= ttl_seconds <= 300:
            raise ValueError("invalid password-ticket limits")
        self._clock = clock
        self._capacity = capacity
        self._ttl = ttl_seconds
        self._records: dict[str, Ticket] = {}
        self._lock = threading.Lock()

    def _expire(self, now: float) -> None:
        for token in tuple(key for key, value in self._records.items() if value.expires_at <= now):
            self._records.pop(token, None)

    def issue(self, purpose: str, origin: str | None, generation: int) -> str:
        if purpose not in {"login", "totp-enrollment"} or not isinstance(generation, int) or generation < 1:
            raise ValueError("invalid password-ticket binding")
        now = self._clock()
        with self._lock:
            self._expire(now)
            if len(self._records) >= self._capacity:
                raise TicketError("password-ticket capacity reached")
            token = secrets.token_urlsafe(32)
            while token in self._records:
                token = secrets.token_urlsafe(32)
            self._records[token] = Ticket(purpose, origin, generation, now + self._ttl)
            return token

    def consume(self, token: object, purpose: str) -> Ticket:
        if not isinstance(token, str) or not 32 <= len(token) <= 64 or not token.isascii():
            raise TicketError("password ticket is unavailable")
        now = self._clock()
        with self._lock:
            self._expire(now)
            ticket = self._records.pop(token, None)
        if ticket is None or ticket.purpose != purpose:
            raise TicketError("password ticket is unavailable")
        return ticket

    def clear(self) -> None:
        """Invalidate every outstanding ticket after an authentication-state change."""
        with self._lock:
            self._records.clear()
