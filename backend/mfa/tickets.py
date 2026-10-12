"""Bounded one-use password tickets and WebAuthn challenges."""

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

TICKET_TTL_SECONDS = 180
TICKET_CAPACITY = 64
MAX_SUBJECT_CHARS = 128
# Login and enrollment complete a session (a recovery code's TOTP re-enrollment among them); an operation ticket
# confirms one exact Supervisor operation, its subject.
PURPOSES = frozenset({"login", "totp-enrollment", "recovery-enrollment", "operation"})


class TicketError(RuntimeError):
    """A password ticket is invalid, expired, reused, or unavailable."""


@dataclass(frozen=True, slots=True)
class Binding:
    """The one session socket, and its session, a step-up ticket issued over that socket belongs to (ADR-0114).

    A ticket with a binding dies with the socket or the session, beside every binding a ticket already has.
    """

    session: str
    socket: str


@dataclass(frozen=True, slots=True)
class Ticket:
    """Private evidence binding password verification to one second-factor attempt."""

    purpose: str
    origin: str | None
    generation: int
    expires_at: float
    subject: str = ""
    binding: Binding | None = None


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

    def issue(
        self, purpose: str, origin: str | None, generation: int, subject: str = "", binding: Binding | None = None
    ) -> str:
        if (
            purpose not in PURPOSES
            or type(generation) is not int
            or generation < 1
            or not _subject_admitted(purpose, subject)
        ):
            raise ValueError("invalid password-ticket binding")
        now = self._clock()
        with self._lock:
            self._expire(now)
            if len(self._records) >= self._capacity:
                raise TicketError("password-ticket capacity reached")
            token = secrets.token_urlsafe(32)
            while token in self._records:
                token = secrets.token_urlsafe(32)
            self._records[token] = Ticket(purpose, origin, generation, now + self._ttl, subject, binding)
            return token

    def consume(self, token: object, purpose: str, subject: str = "", binding: Binding | None = None) -> Ticket:
        """Take one ticket once; one presented for another purpose, subject, or socket is spent all the same."""
        if not isinstance(token, str) or not 32 <= len(token) <= 64 or not token.isascii():
            raise TicketError("password ticket is unavailable")
        now = self._clock()
        with self._lock:
            self._expire(now)
            ticket = self._records.pop(token, None)
        if ticket is None or ticket.purpose != purpose or ticket.subject != subject or ticket.binding != binding:
            raise TicketError("password ticket is unavailable")
        return ticket

    def revoke(self, binding: Binding) -> None:
        """Invalidate every outstanding ticket of one socket, which closed or whose session ended."""
        with self._lock:
            for token in tuple(key for key, value in self._records.items() if value.binding == binding):
                self._records.pop(token, None)

    def clear(self) -> None:
        """Invalidate every outstanding ticket after an authentication-state change."""
        with self._lock:
            self._records.clear()


def _subject_admitted(purpose: str, subject: object) -> bool:
    if purpose != "operation":
        return subject == ""
    return (
        isinstance(subject, str)
        and 0 < len(subject) <= MAX_SUBJECT_CHARS
        and subject.isascii()
        and subject.isprintable()
        and subject == subject.strip()
    )
