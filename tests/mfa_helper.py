"""Test-only helpers that establish the exact current Local MFA contract."""

import base64
import copy
import functools
import hashlib
import hmac
import tempfile
import unittest
from pathlib import Path

NOW = 1_800_000_000


def code(secret: str, timestamp: int = NOW) -> str:
    """Generate one RFC 6238 test code for a fixture secret."""
    key = base64.b32decode(secret)
    step = timestamp // 30
    digest = hmac.new(key, step.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % 1_000_000).zfill(6)


@functools.cache
def _recovery_set():
    from mfa import recovery

    return recovery.new_set()


def recovery_codes() -> tuple[str, ...]:
    """The recovery codes `configure_supervisor` installs: one set derived once per test process."""
    return _recovery_set().codes


def recovery_record() -> dict[str, object]:
    """A private copy of the fixture set's persisted record."""
    return copy.deepcopy(_recovery_set().record)


def configure_supervisor(state_module, password: str) -> str:
    """Create password+TOTP state with the fixture recovery codes and return its current session secret."""
    enrollment = state_module.begin_supervisor_setup(password, now=NOW)
    result = state_module.verify_totp(code(enrollment.secret), ceremony="setup", now=NOW, codes=recovery_record())
    if result.value != "accepted":
        raise AssertionError("test MFA setup failed")
    return state_module.get()["session_secret"]


def isolated_store(case: unittest.TestCase, state_module) -> None:
    """Point the Admin store at a fresh private admin.json for one test and forget any cached store."""
    temporary = tempfile.TemporaryDirectory()
    case.addCleanup(temporary.cleanup)
    previous = state_module.STORE_PATH
    state_module.STORE_PATH = Path(temporary.name) / "admin.json"
    case.addCleanup(setattr, state_module, "STORE_PATH", previous)
    with state_module._STORE_LOCK:
        state_module._store_cache = None
