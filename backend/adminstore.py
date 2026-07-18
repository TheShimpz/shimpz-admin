"""The Admin's private store — `admin.json` (0600), separate from the `.env` keyset.

It holds the password record, session-signing secret, and local model API keys. Model keys stay in
this backend-owned `/data` volume: they are never seeded into a Brain/Team environment, returned
to the browser, or mixed with the platform media key in `.env`.

Fail-loud on corruption: a damaged admin.json RAISES rather than reading as "no password set" —
otherwise a corrupt store would silently re-open first-run bootstrap and let anyone claim the
password. (Contrast with shimpzipc's quarantine-and-continue; here "continue" is a security hole.)
"""

import json
import os
import threading
import time
from pathlib import Path

import auth

STORE_PATH = Path(os.environ.get("SHIMPZ_ADMIN_STORE") or "/data/admin.json")
_MODEL_CREDENTIAL_LOCK = threading.RLock()


def _read():
    """Parse admin.json → dict. Missing file → {} (fresh install). Corrupt → raise (fail-loud)."""
    if not STORE_PATH.exists():
        return {}
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise RuntimeError(f"admin store {STORE_PATH} is corrupt — refusing to read: {e}") from None
    if not isinstance(data, dict):
        raise RuntimeError(f"admin store {STORE_PATH} is not a JSON object")
    return data


def _write(data):
    """Atomically write admin.json 0600 (tmp created 0600 from birth, then renamed on same fs)."""
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_name(f".{STORE_PATH.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(data, indent=2, sort_keys=True).encode("utf-8"))
    finally:
        os.close(fd)
    tmp.replace(STORE_PATH)  # same filesystem (the /data volume) → atomic


def get():
    """Full store dict (may be empty on a fresh install)."""
    return _read()


def is_initialized():
    """True once a password has been set (bootstrap window is closed)."""
    return bool(_read().get("password_hash"))


def set_password(password):
    """Set the admin password (salt + scrypt hash), ensuring a session secret exists too."""
    data = _read()
    salt = auth.new_secret()
    data["salt"] = salt
    data["password_hash"] = auth.hash_password(password, salt)
    if not data.get("session_secret"):
        data["session_secret"] = auth.new_secret()
    data.setdefault("created", int(time.time()))
    _write(data)


def model_credentials():
    """Return the private model-credential records for trusted backend callers only.

    HTTP handlers must project these records through ``modelproviders.status``; this function is
    intentionally not a route and therefore never defines a browser-readable secret surface.
    """
    records = _read().get("model_credentials", {})
    if not isinstance(records, dict):
        raise RuntimeError(f"admin store {STORE_PATH} has invalid model credentials")
    return records


def set_model_api_key(provider, api_key):
    """Atomically persist one remotely verified provider key in the 0600 Admin store."""
    with _MODEL_CREDENTIAL_LOCK:
        data = _read()
        records = data.setdefault("model_credentials", {})
        if not isinstance(records, dict):
            raise RuntimeError(f"admin store {STORE_PATH} has invalid model credentials")
        verified_at = int(time.time())
        records[provider] = {
            "api_key": api_key,
            "updated": verified_at,
            "verified_at": verified_at,
        }
        _write(data)


def delete_model_api_key(provider):
    """Delete one provider key without disturbing the Admin session or other providers."""
    with _MODEL_CREDENTIAL_LOCK:
        data = _read()
        records = data.get("model_credentials", {})
        if not isinstance(records, dict):
            raise RuntimeError(f"admin store {STORE_PATH} has invalid model credentials")
        removed = records.pop(provider, None) is not None
        if removed:
            _write(data)
        return removed
