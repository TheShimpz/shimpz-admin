"""Strict RFC 6238 enrollment and verification for the Local Supervisor."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from enum import Enum

PERIOD_SECONDS = 30
SECRET_BYTES = 20
ENROLLMENT_TTL_SECONDS = 15 * 60
FAILURE_LIMIT = 5
FAILURE_WINDOW_SECONDS = 5 * 60
LOCK_SECONDS = 5 * 60
CODE_RE = re.compile(r"^[0-9]{6}$")
SECRET_RE = re.compile(r"^[A-Z2-7]{32}$")


class TotpStateError(RuntimeError):
    """Persisted TOTP state does not match the exact current contract."""


class Verification(Enum):
    """Secret-free outcome of one persisted TOTP attempt."""

    ACCEPTED = "accepted"
    INVALID = "invalid"
    LOCKED = "locked"
    EXPIRED = "expired"


@dataclass(frozen=True, slots=True)
class Enrollment:
    """One resumable TOTP enrollment projected to the browser."""

    secret: str
    uri: str


def _timestamp(now: int | None) -> int:
    value = int(time.time()) if now is None else now
    if isinstance(value, bool) or not isinstance(value, int) or value < PERIOD_SECONDS:
        raise ValueError("invalid TOTP timestamp")
    return value


def _decode_secret(value: object) -> bytes:
    if not isinstance(value, str) or SECRET_RE.fullmatch(value) is None:
        raise TotpStateError("stored TOTP secret is invalid")
    try:
        decoded = base64.b32decode(value)
    except ValueError as exc:
        raise TotpStateError("stored TOTP secret is invalid") from exc
    if len(decoded) != SECRET_BYTES:
        raise TotpStateError("stored TOTP secret is invalid")
    return decoded


def _hotp(secret: bytes, step: int) -> str:
    digest = hmac.new(secret, step.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % 1_000_000).zfill(6)


def new_record(now: int | None = None) -> dict[str, object]:
    """Create one pending current-contract TOTP factor."""
    created_at = _timestamp(now)
    secret = base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode()
    return {
        "status": "pending",
        "secret": secret,
        "created_at": created_at,
        "resumed_at": created_at,
        "expires_at": created_at + ENROLLMENT_TTL_SECONDS,
        "failures": 0,
        "failure_window_started_at": None,
        "locked_until": None,
        "last_accepted_step": None,
        "activated_at": None,
    }


def _validated(record: object) -> dict[str, object]:
    if not isinstance(record, dict) or set(record) != {
        "status",
        "secret",
        "created_at",
        "resumed_at",
        "expires_at",
        "failures",
        "failure_window_started_at",
        "locked_until",
        "last_accepted_step",
        "activated_at",
    }:
        raise TotpStateError("stored TOTP factor is invalid")
    status = record.get("status")
    created_at = record.get("created_at")
    resumed_at = record.get("resumed_at")
    expires_at = record.get("expires_at")
    failures = record.get("failures")
    window = record.get("failure_window_started_at")
    locked = record.get("locked_until")
    last_step = record.get("last_accepted_step")
    activated_at = record.get("activated_at")
    _decode_secret(record.get("secret"))
    if (
        status not in {"pending", "active"}
        or isinstance(created_at, bool)
        or not isinstance(created_at, int)
        or created_at < PERIOD_SECONDS
        or isinstance(resumed_at, bool)
        or not isinstance(resumed_at, int)
        or resumed_at < created_at
        or isinstance(failures, bool)
        or not isinstance(failures, int)
        or not 0 <= failures <= FAILURE_LIMIT
        or (window is not None and (isinstance(window, bool) or not isinstance(window, int)))
        or (locked is not None and (isinstance(locked, bool) or not isinstance(locked, int)))
        or (last_step is not None and (isinstance(last_step, bool) or not isinstance(last_step, int)))
    ):
        raise TotpStateError("stored TOTP factor is invalid")
    if status == "pending":
        if (
            isinstance(expires_at, bool)
            or not isinstance(expires_at, int)
            or expires_at != resumed_at + ENROLLMENT_TTL_SECONDS
            or last_step is not None
            or activated_at is not None
        ):
            raise TotpStateError("stored pending TOTP factor is invalid")
    elif expires_at is not None or not isinstance(activated_at, int) or activated_at < created_at:
        raise TotpStateError("stored active TOTP factor is invalid")
    return record


def state(record: object) -> str:
    """Return the enrollment state for one strict factor record."""
    status = _validated(record)["status"]
    return "enrollment-required" if status == "pending" else "configured"


def enrollment(record: object) -> Enrollment:
    """Project the pending secret without inventing a username or leaking an origin."""
    factor = _validated(record)
    if factor["status"] != "pending":
        raise TotpStateError("TOTP enrollment is unavailable")
    secret = str(factor["secret"])
    return Enrollment(secret, f"otpauth://totp/Shimpz%20Supervisor?secret={secret}&issuer=Shimpz&digits=6&period=30")


def resume(record: dict[str, object], now: int | None = None) -> Enrollment:
    """Resume the same pending secret inside a fresh bounded confirmation window."""
    factor = _validated(record)
    if factor["status"] != "pending":
        raise TotpStateError("TOTP enrollment is unavailable")
    timestamp = _timestamp(now)
    factor["resumed_at"] = timestamp
    factor["expires_at"] = timestamp + ENROLLMENT_TTL_SECONDS
    return enrollment(factor)


def _matched_step(secret: bytes, code: object, timestamp: int) -> int | None:
    if not isinstance(code, str) or CODE_RE.fullmatch(code) is None:
        return None
    current = timestamp // PERIOD_SECONDS
    matched = None
    for step in range(current - 1, current + 2):
        if hmac.compare_digest(code, _hotp(secret, step)):
            matched = step
    return matched


def _record_failure(record: dict[str, object], timestamp: int) -> Verification:
    window = record["failure_window_started_at"]
    if not isinstance(window, int) or timestamp - window >= FAILURE_WINDOW_SECONDS:
        record["failure_window_started_at"] = timestamp
        record["failures"] = 1
        record["locked_until"] = None
        return Verification.INVALID
    failures = min(int(record["failures"]) + 1, FAILURE_LIMIT)
    record["failures"] = failures
    if failures >= FAILURE_LIMIT:
        record["locked_until"] = timestamp + LOCK_SECONDS
        return Verification.LOCKED
    return Verification.INVALID


def verify(record: dict[str, object], code: object, now: int | None = None) -> Verification:
    """Mutate one validated factor with durable replay and failure evidence."""
    factor = _validated(record)
    timestamp = _timestamp(now)
    if factor["status"] == "pending" and timestamp > int(factor["expires_at"]):
        return Verification.EXPIRED
    locked_until = factor["locked_until"]
    if isinstance(locked_until, int) and locked_until > timestamp:
        return Verification.LOCKED
    matched = _matched_step(_decode_secret(factor["secret"]), code, timestamp)
    last_step = factor["last_accepted_step"]
    if matched is None or (isinstance(last_step, int) and matched <= last_step):
        return _record_failure(factor, timestamp)
    factor["last_accepted_step"] = matched
    factor["failures"] = 0
    factor["failure_window_started_at"] = None
    factor["locked_until"] = None
    if factor["status"] == "pending":
        factor["status"] = "active"
        factor["expires_at"] = None
        factor["activated_at"] = timestamp
    return Verification.ACCEPTED
