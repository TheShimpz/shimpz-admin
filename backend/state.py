"""The Admin's private store — `admin.json` (0600) on its dedicated data volume.

It holds the password record, session-signing secret, and local model API keys. Model keys stay in
this backend-owned `/data` volume: they are never seeded into a Brain/Team environment, returned
to the browser, or mixed with the platform media key in `.env`.

Fail-loud on corruption: a damaged admin.json RAISES rather than reading as "no password set" —
otherwise a corrupt store would silently re-open first-run bootstrap and let anyone claim the
password. (Contrast with shimpzipc's quarantine-and-continue; here "continue" is a security hole.)
"""

import copy
import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import auth
import supervisor

from protocol.http.v1.websocket import canonical_origin

STORE_PATH = Path(os.environ.get("SHIMPZ_ADMIN_STORE") or "/data/admin.json")
_BROWSER_ORIGIN_LOCK = threading.RLock()
_MODEL_CREDENTIAL_LOCK = threading.RLock()
_STORE_LOCK = threading.RLock()


@dataclass(frozen=True)
class _StoreCache:
    path: Path
    identity: tuple[int, int, int, int] | None
    data: dict


_store_cache: _StoreCache | None = None


def _store_identity(path: Path) -> tuple[int, int, int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def _read_store_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _read():
    """Parse admin.json → dict. Missing file → {} (fresh install). Corrupt → raise (fail-loud)."""
    global _store_cache
    path = STORE_PATH
    with _STORE_LOCK:
        identity = _store_identity(path)
        if _store_cache is not None and (_store_cache.path, _store_cache.identity) == (path, identity):
            return copy.deepcopy(_store_cache.data)
        if identity is None:
            data = {}
        else:
            try:
                data = json.loads(_read_store_file(path))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                raise RuntimeError(f"admin store {path} is corrupt — refusing to read: {e}") from None
            if _store_identity(path) != identity:
                raise RuntimeError(f"admin store {path} changed while reading")
            if not isinstance(data, dict):
                raise RuntimeError(f"admin store {path} is not a JSON object")
        _store_cache = _StoreCache(path, identity, data)
        return copy.deepcopy(data)


def _write(data):
    """Atomically write admin.json 0600 (tmp created 0600 from birth, then renamed on same fs)."""
    global _store_cache
    with _STORE_LOCK:
        if not isinstance(data, dict):
            raise RuntimeError(f"admin store {STORE_PATH} is not a JSON object")
        payload = json.dumps(data, indent=2, sort_keys=True).encode("utf-8")
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_name(f".{STORE_PATH.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        tmp.replace(STORE_PATH)  # same filesystem (the /data volume) → atomic
        _store_cache = _StoreCache(STORE_PATH, _store_identity(STORE_PATH), copy.deepcopy(data))


def get():
    """Full store dict (may be empty on a fresh install)."""
    return _read()


def is_initialized():
    """True once a password has been set (bootstrap window is closed)."""
    return bool(_read().get("password_hash"))


def _validated_browser_origin(data: dict) -> str | None:
    origin = data.get("browser_origin")
    if origin is None:
        return None
    if not isinstance(origin, str) or canonical_origin(origin) != origin or not origin.startswith("https://"):
        raise RuntimeError(f"admin store {STORE_PATH} has an invalid browser origin")
    return origin


def browser_origin() -> str | None:
    """Return the one password-authorized external HTTPS browser origin, when configured."""
    return _validated_browser_origin(_read())


def bind_browser_origin(origin: str) -> str:
    """Persist one exact external HTTPS origin, returning its material transition."""
    if canonical_origin(origin) != origin or not origin.startswith("https://"):
        raise ValueError("browser origin must be one exact HTTPS origin")
    with _BROWSER_ORIGIN_LOCK:
        data = _read()
        current = _validated_browser_origin(data)
        if current == origin:
            return "unchanged"
        data["browser_origin"] = origin
        _write(data)
        return "learned" if current is None else "replaced"


def set_password(password, browser_origin: str | None = None):
    """Set the admin password (salt + scrypt hash), ensuring a session secret exists too."""
    if browser_origin is not None and (
        canonical_origin(browser_origin) != browser_origin or not browser_origin.startswith("https://")
    ):
        raise ValueError("browser origin must be one exact HTTPS origin")
    data = _read()
    salt = auth.new_secret()
    data["salt"] = salt
    data["password_hash"] = auth.hash_password(password, salt)
    if not data.get("session_secret"):
        data["session_secret"] = auth.new_secret()
    identity_fields = {"supervisor_id", "supervisor_signing_key"} & set(data)
    if identity_fields:
        identity = supervisor.identity_from_record(data)
    else:
        identity = supervisor.new_identity()
        data["supervisor_id"] = identity.supervisor_id
        data["supervisor_signing_key"] = identity.private_key_hex
    data.setdefault("created", int(time.time()))
    if browser_origin is not None:
        data["browser_origin"] = browser_origin
    _write(data)


def local_supervisor() -> supervisor.LocalIdentity:
    """Return the validated private Local Supervisor identity."""
    return supervisor.identity_from_record(_read())


def model_credentials():
    """Return the private model-credential records for trusted backend callers only.

    HTTP handlers must project these records through ``models.status``; this function is
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
