"""Test-only helpers that establish the exact current Local MFA contract."""

from __future__ import annotations

import base64
import hashlib
import hmac

NOW = 1_800_000_000


def code(secret: str, timestamp: int = NOW) -> str:
    """Generate one RFC 6238 test code for a fixture secret."""
    key = base64.b32decode(secret)
    step = timestamp // 30
    digest = hmac.new(key, step.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % 1_000_000).zfill(6)


def configure_supervisor(state_module, password: str) -> str:
    """Create password+TOTP state and return its current session secret."""
    enrollment = state_module.begin_supervisor_setup(password, now=NOW)
    result = state_module.verify_totp(code(enrollment.secret), enrollment=True, now=NOW)
    if result.value != "accepted":
        raise AssertionError("test MFA setup failed")
    return state_module.get()["session_secret"]
