"""The admin panel's own credential store — `admin.json` (0600), separate from the `.env` keyset.

Holds the operator's password hash + salt + the session-signing secret. Deliberately NOT a `.env`
key: it would break the SCHEMA↔.env.example parity gate and, worse, get seeded into the brain's
`$SHIMPZ_HOME/.env`. It lives on the panel's own `/data` volume.

Fail-loud on corruption: a damaged admin.json RAISES rather than reading as "no password set" —
otherwise a corrupt store would silently re-open first-run bootstrap and let anyone claim the
password. (Contrast with shimpzipc's quarantine-and-continue; here "continue" is a security hole.)
"""

import json
import os
import time
from pathlib import Path

import auth

STORE_PATH = Path(os.environ.get("SHIMPZ_ADMIN_STORE") or "/data/admin.json")


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


def ensure_secret():
    """Return the session-signing secret, creating (and persisting) one if absent.

    Called before issuing any session — including the shimpz-setup bootstrap bridge — so a secret
    exists even before a password is set. Does NOT set a password (is_initialized stays False).
    """
    data = _read()
    if not data.get("session_secret"):
        data["session_secret"] = auth.new_secret()
        data.setdefault("created", int(time.time()))
        _write(data)
    return data["session_secret"]


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
