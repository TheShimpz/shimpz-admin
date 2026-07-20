"""One-use browser handoffs for local OAuth callbacks.

The Admin session cookie belongs to the hostname the operator used (commonly
``localhost``), while reviewed local OAuth callbacks deliberately use
``127.0.0.1``. Cookies cannot safely cross that hostname boundary. This tiny
process-local store therefore lets an authenticated Admin request mint one
short-lived bearer handoff. The loopback start route consumes it exactly once,
sets a separate short-lived callback cookie, and never exposes that callback
binding to JavaScript.

No OAuth token, authorization code, PKCE verifier, or provider client material
is stored here.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

HANDOFF_TTL_SECONDS = 90
HANDOFF_CAPACITY = 256

_TEAM_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


class OAuthHandoffError(RuntimeError):
    """The local OAuth handoff is invalid, expired, reused, or unavailable."""


@dataclass(frozen=True)
class OAuthHandoff:
    """Private data recovered only after consuming a one-use handoff."""

    team_id: str
    challenge_id: str
    session_binding: str


@dataclass(frozen=True)
class _PendingHandoff:
    handoff: OAuthHandoff
    admin_session_digest: bytes
    expires_at: float


def _admin_session_digest(session_token: object) -> bytes:
    if (
        not isinstance(session_token, str)
        or not 32 <= len(session_token) <= 512
        or not session_token.isascii()
        or any(ord(character) < 33 or ord(character) > 126 for character in session_token)
    ):
        raise OAuthHandoffError("Admin session is unavailable")
    return hashlib.sha256(session_token.encode("ascii")).digest()


def _team_id(value: object) -> str:
    if not isinstance(value, str) or _TEAM_ID_RE.fullmatch(value) is None:
        raise OAuthHandoffError("OAuth Team binding is invalid")
    return value


def _challenge_id(value: object) -> str:
    if not isinstance(value, str) or _CHALLENGE_ID_RE.fullmatch(value) is None:
        raise OAuthHandoffError("OAuth challenge is invalid")
    return value


def _token(value: object) -> str:
    if not isinstance(value, str) or _TOKEN_RE.fullmatch(value) is None:
        raise OAuthHandoffError("OAuth handoff is unavailable")
    return value


class OAuthHandoffStore:
    """Bounded in-memory handoffs; restart and expiry both fail closed."""

    def __init__(
        self,
        *,
        capacity: int = HANDOFF_CAPACITY,
        ttl_seconds: int = HANDOFF_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 1 <= capacity <= 4096 or not 15 <= ttl_seconds <= 300:
            raise ValueError("OAuth handoff limits are invalid")
        self._capacity = capacity
        self._ttl = ttl_seconds
        self._clock = clock
        self._pending: dict[str, _PendingHandoff] = {}
        self._lock = threading.Lock()

    def _expire(self, now: float) -> None:
        expired = tuple(token for token, pending in self._pending.items() if pending.expires_at <= now)
        for token in expired:
            self._pending.pop(token, None)

    def issue(self, *, team_id: object, challenge_id: object, admin_session: object) -> str:
        """Issue a one-use handoff only after the caller proved an Admin session."""
        team = _team_id(team_id)
        challenge = _challenge_id(challenge_id)
        digest = _admin_session_digest(admin_session)
        now = self._clock()
        with self._lock:
            self._expire(now)
            if len(self._pending) >= self._capacity:
                raise OAuthHandoffError("OAuth handoff capacity reached")
            if any(
                hmac.compare_digest(pending.admin_session_digest, digest)
                and pending.handoff.team_id == team
                and pending.handoff.challenge_id == challenge
                for pending in self._pending.values()
            ):
                raise OAuthHandoffError("OAuth authorization is already pending")

            token = secrets.token_urlsafe(32)
            while token in self._pending:
                token = secrets.token_urlsafe(32)
            binding = secrets.token_urlsafe(32)
            self._pending[token] = _PendingHandoff(
                handoff=OAuthHandoff(team, challenge, binding),
                admin_session_digest=digest,
                expires_at=now + self._ttl,
            )
            return token

    def consume(self, value: object) -> OAuthHandoff:
        """Consume before returning so every failure after this point requires a restart."""
        token = _token(value)
        now = self._clock()
        with self._lock:
            self._expire(now)
            pending = self._pending.pop(token, None)
        if pending is None:
            raise OAuthHandoffError("OAuth handoff is unavailable")
        return pending.handoff

    def cancel_session(self, admin_session: object) -> int:
        """Invalidate all not-yet-consumed handoffs for one logged-out Admin session."""
        digest = _admin_session_digest(admin_session)
        now = self._clock()
        with self._lock:
            self._expire(now)
            tokens = tuple(
                token
                for token, pending in self._pending.items()
                if hmac.compare_digest(pending.admin_session_digest, digest)
            )
            for token in tokens:
                self._pending.pop(token, None)
            return len(tokens)
