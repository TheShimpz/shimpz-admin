"""One-use browser handoffs for local OAuth callbacks.

The Admin session cookie belongs to the hostname the Supervisor used (commonly
``localhost``), while reviewed local OAuth callbacks deliberately use
``127.0.0.1``. Cookies cannot safely cross that hostname boundary. This tiny
process-local store therefore lets an authenticated Admin request authorize
the provider flow through Team, then publish one short-lived bearer handoff
containing only the already-validated redirect URL and a callback binding. The
loopback start route consumes it exactly once, sets a separate short-lived
callback cookie, and never exposes that callback binding to JavaScript.

No Admin or Account session, OAuth token, authorization code, PKCE verifier,
or provider client material is stored here.
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
from urllib.parse import urlsplit

from protocol.http.v1 import websocket as chat_ws_common

HANDOFF_TTL_SECONDS = 90
HANDOFF_CAPACITY = 256

_TEAM_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_HANDOFF_RE = re.compile(r"^[0-9a-f]{64}$")


class OAuthHandoffError(RuntimeError):
    """The local OAuth handoff is invalid, expired, reused, or unavailable."""


@dataclass(frozen=True)
class OAuthPreparation:
    """Opaque handoff token and browser binding used during authenticated preparation."""

    token: str
    session_binding: str


@dataclass(frozen=True)
class OAuthHandoff:
    """Private redirect data recovered only after consuming an authorized handoff."""

    authorization_url: str
    session_binding: str


@dataclass(frozen=True)
class _PendingHandoff:
    team_id: str
    challenge_id: str
    session_binding: str
    authorization_url: str | None
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
    if not isinstance(value, str) or chat_ws_common.CHALLENGE_ID_RE.fullmatch(value) is None:
        raise OAuthHandoffError("OAuth challenge is invalid")
    return value


def _token(value: object) -> str:
    if not isinstance(value, str) or _HANDOFF_RE.fullmatch(value) is None:
        raise OAuthHandoffError("OAuth handoff is unavailable")
    return value


def _authorization_url(value: object) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 4096
        or not value.isascii()
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        raise OAuthHandoffError("OAuth authorization URL is invalid")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise OAuthHandoffError("OAuth authorization URL is invalid") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "shimpz.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/api/oauth/cloudflare/start"
        or parsed.fragment
    ):
        raise OAuthHandoffError("OAuth authorization URL is invalid")
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

    def issue(self, *, team_id: object, challenge_id: object, admin_session: object) -> OAuthPreparation:
        """Reserve one handoff while an authenticated caller asks Team for authorization."""
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
                and pending.team_id == team
                and pending.challenge_id == challenge
                for pending in self._pending.values()
            ):
                raise OAuthHandoffError("OAuth authorization is already pending")

            token = secrets.token_hex(32)
            while token in self._pending:
                token = secrets.token_hex(32)
            binding = secrets.token_urlsafe(32)
            self._pending[token] = _PendingHandoff(
                team_id=team,
                challenge_id=challenge,
                session_binding=binding,
                authorization_url=None,
                admin_session_digest=digest,
                expires_at=now + self._ttl,
            )
            return OAuthPreparation(token, binding)

    def authorize(self, value: object, authorization_url: object) -> None:
        """Publish one redirect only after Team returned a strictly validated URL."""
        token = _token(value)
        redirect = _authorization_url(authorization_url)
        now = self._clock()
        with self._lock:
            self._expire(now)
            pending = self._pending.get(token)
            if pending is None or pending.authorization_url is not None:
                raise OAuthHandoffError("OAuth handoff is unavailable")
            self._pending[token] = _PendingHandoff(
                team_id=pending.team_id,
                challenge_id=pending.challenge_id,
                session_binding=pending.session_binding,
                authorization_url=redirect,
                admin_session_digest=pending.admin_session_digest,
                expires_at=pending.expires_at,
            )

    def consume(self, value: object) -> OAuthHandoff:
        """Consume one authorized handoff before exposing its redirect and binding."""
        token = _token(value)
        now = self._clock()
        with self._lock:
            self._expire(now)
            pending = self._pending.pop(token, None)
        if pending is None or pending.authorization_url is None:
            raise OAuthHandoffError("OAuth handoff is unavailable")
        return OAuthHandoff(pending.authorization_url, pending.session_binding)

    def discard(self, value: object) -> bool:
        """Remove an incomplete reservation after Team rejects or transport fails."""
        token = _token(value)
        with self._lock:
            return self._pending.pop(token, None) is not None

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
