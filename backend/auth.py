"""Local Supervisor password verification, login throttling, and signed sessions."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import math
import re
import secrets
import threading
import time
import unicodedata
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass

MIN_PASSWORD_CHARS = 15
MAX_PASSWORD_CHARS = 4 * 1024
RECORD_STATE_CONFIGURED = "configured"
RECORD_STATE_ENROLLMENT_REQUIRED = "enrollment-required"
RECORD_STATE_RECOVERY_REQUIRED = "recovery-required"
RECORD_STATE_UNINITIALIZED = "uninitialized"

_SCHEME = "scrypt-v1"
_N, _R, _P, _DKLEN = 2**14, 8, 5, 32
_MAXMEM = 128 * _N * _R * 4  # scrypt uses about 16 MiB; retain explicit OpenSSL headroom.
_PARAMETERS = "ln=14,r=8,p=5,dk=32"
_VERIFIER = re.compile(
    rf"^{_SCHEME}\${re.escape(_PARAMETERS)}\$([0-9a-f]{{64}})\$([0-9a-f]{{64}})$"
)
_RETIRED_PASSWORD_FIELDS = frozenset({"salt", "password_hash"})
_BLOCKLIST = frozenset(
    {
        "123456789012345",
        "1234567890123456",
        "admin admin admin",
        "adminadminadmin",
        "administrator123",
        "correct horse battery staple",
        "correcthorsebatterystaple",
        "default supervisor password",
        "iloveyouiloveyou",
        "letmeinletmeinletmein",
        "password password",
        "password123456789",
        "passwordpassword",
        "qwertyuiopasdfgh",
        "shimpz admin password",
        "shimpz supervisor",
        "shimpzadminpassword",
        "shimpzsupervisor",
        "supervisor password",
        "this is a password",
        "thisismypassword",
    }
)

LOGIN_FAILURE_LIMIT = 5
LOGIN_LOCK_SECONDS = 60

TTL = 7 * 24 * 3600
_SESSION_SCHEME = "v2"
_SESSION_METHODS = frozenset({"totp", "webauthn"})


class PasswordRecordError(RuntimeError):
    """The stored Local Supervisor password record is not the exact current contract."""


class LoginRateLimitedError(RuntimeError):
    """A Local login cannot reserve one bounded password-verification attempt."""

    def __init__(self, retry_after: int) -> None:
        super().__init__("too many login attempts")
        self.retry_after = retry_after


@dataclass(frozen=True, slots=True)
class SessionEvidence:
    """Signed Local session evidence for one completed MFA ceremony."""

    expires_at: int
    method: str


class LocalLoginLimiter:
    """Bound the singleton Local login before any expensive password work begins."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        failure_limit: int = LOGIN_FAILURE_LIMIT,
        lock_seconds: int = LOGIN_LOCK_SECONDS,
    ) -> None:
        self._clock = clock
        self._failure_limit = failure_limit
        self._lock_seconds = lock_seconds
        self._lock = threading.Lock()
        self._in_flight = False
        self._failures = 0
        self._locked_until = 0.0

    def begin(self) -> None:
        """Reserve the only hash slot or reject immediately without queueing."""
        with self._lock:
            now = self._clock()
            if self._locked_until > now:
                raise LoginRateLimitedError(max(1, math.ceil(self._locked_until - now)))
            if self._locked_until:
                self._failures = 0
                self._locked_until = 0.0
            if self._in_flight:
                raise LoginRateLimitedError(1)
            self._in_flight = True

    def finish(self, *, rejected: bool | None) -> int:
        """Release the hash slot and return a new lock duration, when one begins."""
        with self._lock:
            if not self._in_flight:
                raise RuntimeError("unbalanced Local login rate-limit permit")
            self._in_flight = False
            if rejected is None:
                return 0
            if not rejected:
                self._failures = 0
                self._locked_until = 0.0
                return 0
            self._failures += 1
            if self._failures < self._failure_limit:
                return 0
            self._locked_until = self._clock() + self._lock_seconds
            return self._lock_seconds


async def attempt_login(
    password: str,
    record: object,
    limiter: LocalLoginLimiter,
) -> tuple[bool, int]:
    """Reserve immediately and retain the slot until the off-loop derivation finishes."""
    limiter.begin()
    verified: bool | None = None
    worker = asyncio.create_task(asyncio.to_thread(verify_password, password, record))
    try:
        try:
            verified = await asyncio.shield(worker)
        except asyncio.CancelledError:
            with suppress(Exception):
                await worker
            raise
    finally:
        lock_seconds = limiter.finish(rejected=None if verified is None else not verified)
    return verified, lock_seconds


def new_secret() -> str:
    """Return one random 32-byte hex secret."""
    return secrets.token_hex(32)


def _normalized_password(password: str) -> str:
    normalized = unicodedata.normalize("NFKC", password).casefold()
    return " ".join(normalized.split())


def _is_repeated_unit(value: str) -> bool:
    return len(value) > 1 and value in (value + value)[1:-1]


def password_policy(password: str) -> str | None:
    """Return the exact setup-policy rejection code, or ``None`` when admitted."""
    if len(password) < MIN_PASSWORD_CHARS:
        return "password-too-short"
    if len(password) > MAX_PASSWORD_CHARS:
        return "password-too-long"
    normalized = _normalized_password(password)
    if len(normalized) < MIN_PASSWORD_CHARS:
        return "password-too-short"
    if normalized in _BLOCKLIST or _is_repeated_unit(normalized):
        return "password-blocklisted"
    return None


def _derive(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_N,
        r=_R,
        p=_P,
        dklen=_DKLEN,
        maxmem=_MAXMEM,
    )


def new_password_verifier(password: str) -> str:
    """Create one strict current-contract verifier for an admitted new password."""
    if violation := password_policy(password):
        raise ValueError(violation)
    salt = secrets.token_bytes(32)
    digest = _derive(password, salt)
    return f"{_SCHEME}${_PARAMETERS}${salt.hex()}${digest.hex()}"


def _password_material(record: object) -> tuple[bytes, bytes] | None:
    if not isinstance(record, Mapping):
        raise PasswordRecordError("Local Supervisor password record is invalid")
    verifier = record.get("password_verifier")
    retired = _RETIRED_PASSWORD_FIELDS & set(record)
    if verifier is None and not retired:
        return None
    match = _VERIFIER.fullmatch(verifier) if isinstance(verifier, str) else None
    if retired or match is None:
        raise PasswordRecordError("Local Supervisor password record requires bounded recovery")
    return bytes.fromhex(match.group(1)), bytes.fromhex(match.group(2))


def password_state(record: object) -> str:
    """Return whether the strict password verifier exists, independent of MFA enrollment."""
    if _password_material(record) is None:
        return RECORD_STATE_UNINITIALIZED
    return RECORD_STATE_CONFIGURED


def verify_password(password: str, record: object) -> bool:
    """Verify one bounded password against only the exact current record contract."""
    if not isinstance(password, str) or not 1 <= len(password) <= MAX_PASSWORD_CHARS:
        raise ValueError("invalid password input")
    material = _password_material(record)
    if material is None:
        raise PasswordRecordError("Local Supervisor password is not configured")
    salt, expected = material
    return hmac.compare_digest(_derive(password, salt), expected)


def issue_session(secret_hex: str, method: str, ttl: int = TTL) -> str:
    """Mint a signed Local MFA session token valid for ``ttl`` seconds."""
    if method not in _SESSION_METHODS:
        raise ValueError("invalid Local session authentication method")
    exp = int(time.time()) + int(ttl)
    body = f"{_SESSION_SCHEME}:{exp}:{secrets.token_hex(8)}:pwd+{method}"
    sig = hmac.new(bytes.fromhex(secret_hex), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}:{sig}"


def _session_parts(token: str) -> tuple[list[str], str] | None:
    parts = token.split(":")
    if len(parts) != 5 or parts[0] != _SESSION_SCHEME or not parts[3].startswith("pwd+"):
        return None
    method = parts[3].removeprefix("pwd+")
    return (parts, method) if method in _SESSION_METHODS else None


def verify_session(secret_hex: str, token: str) -> SessionEvidence | None:
    """Return structured MFA evidence for an authentic, unexpired Local session."""
    parsed = _session_parts(token) if secret_hex and token else None
    if parsed is None:
        return None
    parts, method = parsed
    body = ":".join(parts[:4])
    try:
        expected = hmac.new(bytes.fromhex(secret_hex), body.encode("utf-8"), hashlib.sha256).hexdigest()
    except ValueError:
        return None
    if not hmac.compare_digest(parts[4], expected):
        return None
    try:
        expires_at = int(parts[1])
    except ValueError:
        return None
    if expires_at <= time.time():
        return None
    return SessionEvidence(expires_at, method)
