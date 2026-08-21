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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import auth
import supervisor
from mfa import passkeys as webauthn
from mfa import totp

from protocol.http.v1.websocket import canonical_origin

STORE_PATH = Path(os.environ.get("SHIMPZ_ADMIN_STORE") or "/data/admin.json")
_STORE_LOCK = threading.RLock()
AUTH_VERSION = 1
MAX_CONSUMED_HOST_RESETS = 128


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


def _always_write(_result: object) -> bool:
    return True


def _mutate(
    update: Callable[[dict], object],
    should_write: Callable[[object], bool] = _always_write,
) -> object:
    """Hold one lock across the complete read-modify-write transaction."""
    with _STORE_LOCK:
        data = _read()
        result = update(data)
        if should_write(result):
            _write(data)
        return result


def get():
    """Full store dict (may be empty on a fresh install)."""
    return _read()


def password_state() -> str:
    """Return the exact current Local Supervisor password state."""
    return auth.password_state(_read())


def _authentication_state(data: dict) -> str:
    password = auth.password_state(data)
    if password == auth.RECORD_STATE_UNINITIALIZED:
        if set(data) - {"consumed_host_resets"}:
            raise auth.PasswordRecordError("Local Supervisor MFA record requires bounded recovery")
        if "consumed_host_resets" in data:
            _validated_consumed_host_resets(data["consumed_host_resets"])
        return auth.RECORD_STATE_UNINITIALIZED
    generation = data.get("factor_generation")
    user_id = data.get("webauthn_user_id")
    passkey_records = data.get("passkeys")
    session_secret = data.get("session_secret")
    if (
        data.get("auth_version") != AUTH_VERSION
        or isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
        or not isinstance(user_id, str)
        or len(user_id) != 64
        or any(character not in "0123456789abcdef" for character in user_id)
        or not isinstance(passkey_records, list)
        or not isinstance(session_secret, str)
        or len(session_secret) != 64
        or any(character not in "0123456789abcdef" for character in session_secret)
    ):
        raise auth.PasswordRecordError("Local Supervisor MFA record requires bounded recovery")
    try:
        _validated_passkeys(passkey_records)
        return totp.state(data.get("totp"))
    except (totp.TotpStateError, webauthn.PasskeyError) as exc:
        raise auth.PasswordRecordError("Local Supervisor MFA record requires bounded recovery") from exc


def _validated_passkey(record: object) -> dict[str, object]:
    fields = {
        "credential_id",
        "public_key",
        "sign_count",
        "backup_eligible",
        "backup_state",
        "rp_id",
        "origin",
        "status",
        "created_at",
        "updated_at",
        "last_used_at",
    }
    if not isinstance(record, dict) or set(record) != fields:
        raise webauthn.PasskeyError("stored passkey is invalid")
    credential_id = record["credential_id"]
    public_key = record["public_key"]
    sign_count = record["sign_count"]
    timestamps = (record["created_at"], record["updated_at"], record["last_used_at"])
    if (
        not isinstance(credential_id, str)
        or webauthn.IDENTIFIER_RE.fullmatch(credential_id) is None
        or not isinstance(public_key, str)
        or webauthn.IDENTIFIER_RE.fullmatch(public_key) is None
        or isinstance(sign_count, bool)
        or not isinstance(sign_count, int)
        or sign_count < 0
        or not isinstance(record["backup_eligible"], bool)
        or not isinstance(record["backup_state"], bool)
        or (record["backup_state"] and not record["backup_eligible"])
        or record["status"] not in {"active", "suspended"}
        or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in timestamps)
        or not timestamps[0] <= timestamps[1]
        or not timestamps[0] <= timestamps[2]
    ):
        raise webauthn.PasskeyError("stored passkey is invalid")
    origin = record["origin"]
    rp_id = record["rp_id"]
    if not isinstance(origin, str) or not isinstance(rp_id, str) or webauthn.rp_id_for_origin(origin) != rp_id:
        raise webauthn.PasskeyError("stored passkey origin is invalid")
    return record


def _validated_passkeys(records: object) -> list[dict[str, object]]:
    if not isinstance(records, list) or len(records) > webauthn.MAX_PASSKEYS:
        raise webauthn.PasskeyError("stored passkeys are invalid")
    validated = [_validated_passkey(record) for record in records]
    identifiers = [str(record["credential_id"]) for record in validated]
    if len(identifiers) != len(set(identifiers)):
        raise webauthn.PasskeyError("stored passkeys are invalid")
    return validated


def authentication_state() -> str:
    """Return the exact current Local Supervisor authentication state."""
    return _authentication_state(_read())


def is_initialized():
    """True as soon as any strict password record has closed the bootstrap window."""
    return password_state() != auth.RECORD_STATE_UNINITIALIZED


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
    def bind(data: dict) -> str:
        current = _validated_browser_origin(data)
        if current == origin:
            return "unchanged"
        data["browser_origin"] = origin
        return "learned" if current is None else "replaced"

    return str(_mutate(bind, lambda result: result != "unchanged"))


def begin_supervisor_setup(password: str, *, now: int | None = None) -> totp.Enrollment:
    """Create the password and resumable mandatory TOTP enrollment atomically."""
    def begin(data: dict) -> totp.Enrollment:
        if auth.password_state(data) != auth.RECORD_STATE_UNINITIALIZED:
            raise RuntimeError("Local Supervisor password is already configured")
        if {"session_secret", "supervisor_id", "supervisor_signing_key", "created"} & set(data):
            raise supervisor.SupervisorAuthorityError("Local Supervisor identity is incomplete")
        data["password_verifier"] = auth.new_password_verifier(password)
        data["session_secret"] = auth.new_secret()
        identity = supervisor.new_identity()
        data["supervisor_id"] = identity.supervisor_id
        data["supervisor_signing_key"] = identity.private_key_hex
        data["auth_version"] = AUTH_VERSION
        data["factor_generation"] = 1
        data["webauthn_user_id"] = auth.new_secret()
        data["passkeys"] = []
        data["totp"] = totp.new_record(now)
        data["created"] = int(time.time()) if now is None else now
        return totp.enrollment(data["totp"])

    return cast(totp.Enrollment, _mutate(begin))


def totp_enrollment() -> totp.Enrollment:
    """Return only the current pending TOTP enrollment projection."""
    data = _read()
    if _authentication_state(data) != auth.RECORD_STATE_ENROLLMENT_REQUIRED:
        raise totp.TotpStateError("TOTP enrollment is unavailable")
    return totp.enrollment(data["totp"])


def resume_totp_enrollment(*, now: int | None = None) -> totp.Enrollment:
    """Resume the same pending secret after bounded password verification."""
    def resume(data: dict) -> totp.Enrollment:
        if _authentication_state(data) != auth.RECORD_STATE_ENROLLMENT_REQUIRED:
            raise totp.TotpStateError("TOTP enrollment is unavailable")
        return totp.resume(data["totp"], now)

    return cast(totp.Enrollment, _mutate(resume))


def factor_generation() -> int:
    """Return the current validated factor generation."""
    data = _read()
    _authentication_state(data)
    return int(data["factor_generation"])


def webauthn_user_id() -> str:
    """Return the stable opaque user handle for registration options."""
    data = _read()
    _authentication_state(data)
    return str(data["webauthn_user_id"])


def active_passkeys(origin: str) -> list[dict[str, object]]:
    """Return private copies of active credentials for one exact origin."""
    rp_id = webauthn.rp_id_for_origin(origin)
    data = _read()
    _authentication_state(data)
    return [
        copy.deepcopy(record)
        for record in _validated_passkeys(data["passkeys"])
        if record["status"] == "active" and record["origin"] == origin and record["rp_id"] == rp_id
    ]


def passkeys_for_registration(origin: str) -> list[dict[str, object]]:
    """Return same-origin exclusions only while global active capacity remains."""
    rp_id = webauthn.rp_id_for_origin(origin)
    data = _read()
    _authentication_state(data)
    records = _validated_passkeys(data["passkeys"])
    active = [record for record in records if record["status"] == "active"]
    if len(active) >= webauthn.MAX_PASSKEYS:
        raise webauthn.PasskeyUnavailableError("maximum passkey count reached")
    return [
        copy.deepcopy(record)
        for record in active
        if record["origin"] == origin and record["rp_id"] == rp_id
    ]


def passkey_for_authentication(credential_id: str, origin: str) -> dict[str, object]:
    """Select one active exact-origin credential without exposing it through HTTP."""
    matches = [record for record in active_passkeys(origin) if record["credential_id"] == credential_id]
    if len(matches) != 1:
        raise webauthn.PasskeyUnavailableError("invalid passkey authentication")
    return matches[0]


def add_passkey(record: dict[str, object], generation: int) -> str:
    """Persist one verified credential and rotate all existing sessions."""
    validated = _validated_passkey(copy.deepcopy(record))

    def add(data: dict) -> str:
        if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED or data["factor_generation"] != generation:
            raise webauthn.PasskeyConflictError("authentication factors changed; retry")
        records = [record for record in _validated_passkeys(data["passkeys"]) if record["status"] == "active"]
        if len(records) >= webauthn.MAX_PASSKEYS or any(
            current["credential_id"] == validated["credential_id"] for current in records
        ):
            raise webauthn.PasskeyConflictError("passkey is unavailable")
        data["passkeys"] = [*records, validated]
        data["factor_generation"] = generation + 1
        data["session_secret"] = auth.new_secret()
        return str(data["session_secret"])

    return str(_mutate(add))


def commit_passkey_authentication(
    original: dict[str, object],
    result: webauthn.Authentication,
    generation: int,
    *,
    now: int,
) -> tuple[str, str | None]:
    """Commit one assertion update or suspension against the exact original record."""
    expected = _validated_passkey(copy.deepcopy(original))

    def commit(data: dict) -> tuple[str, str | None]:
        if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED or data["factor_generation"] != generation:
            raise webauthn.PasskeyConflictError("authentication factors changed; retry")
        records = _validated_passkeys(data["passkeys"])
        matches = [record for record in records if record["credential_id"] == result.credential_id]
        if len(matches) != 1 or matches[0] != expected:
            raise webauthn.PasskeyConflictError("passkey changed; retry")
        record = matches[0]
        counter_regressed = int(record["sign_count"]) > 0 and result.new_sign_count <= int(record["sign_count"])
        identity_changed = (
            result.backup_eligible != record["backup_eligible"]
            or (result.backup_state and not result.backup_eligible)
        )
        record["last_used_at"] = now
        record["updated_at"] = now
        if counter_regressed or identity_changed:
            record["status"] = "suspended"
            data["factor_generation"] = generation + 1
            data["session_secret"] = auth.new_secret()
            reason = "counter-regression" if counter_regressed else "backup-identity-change"
            return str(data["session_secret"]), reason
        record["sign_count"] = result.new_sign_count
        record["backup_state"] = result.backup_state
        return str(data["session_secret"]), None

    return cast(tuple[str, str | None], _mutate(commit))


def verify_totp(code: object, *, enrollment: bool, now: int | None = None) -> totp.Verification:
    """Persist one TOTP attempt, activation, replay evidence, and session rotation."""
    expected = auth.RECORD_STATE_ENROLLMENT_REQUIRED if enrollment else auth.RECORD_STATE_CONFIGURED

    def verify(data: dict) -> totp.Verification:
        if _authentication_state(data) != expected:
            raise totp.TotpStateError("TOTP ceremony is unavailable")
        result = totp.verify(data["totp"], code, now)
        if result is totp.Verification.ACCEPTED and enrollment:
            data["factor_generation"] = int(data["factor_generation"]) + 1
            data["session_secret"] = auth.new_secret()
        return result

    return cast(totp.Verification, _mutate(verify))


def consume_host_reset_capability(digest: str, expires_at: int, *, now: int | None = None) -> bool:
    """Durably consume one purpose-bound host reset capability digest."""
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
        or expires_at < 1
    ):
        raise ValueError("invalid host reset capability evidence")

    timestamp = int(time.time()) if now is None else now
    if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 1:
        raise ValueError("invalid host reset consumption time")

    def consume(data: dict) -> bool:
        records = _validated_consumed_host_resets(data.get("consumed_host_resets", []))
        active = [record for record in records if record["expires_at"] >= timestamp]
        if any(record["digest"] == digest for record in active) or len(active) >= MAX_CONSUMED_HOST_RESETS:
            return False
        data["consumed_host_resets"] = [*active, {"digest": digest, "expires_at": expires_at}]
        return True

    return bool(_mutate(consume, bool))


def _validated_consumed_host_resets(records: object) -> list[dict[str, object]]:
    if not isinstance(records, list) or len(records) > MAX_CONSUMED_HOST_RESETS:
        raise RuntimeError(f"admin store {STORE_PATH} has invalid host reset evidence")
    digests: set[str] = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or set(record) != {"digest", "expires_at"}
            or not isinstance(record.get("digest"), str)
            or len(record["digest"]) != 64
            or any(character not in "0123456789abcdef" for character in record["digest"])
            or record["digest"] in digests
            or isinstance(record.get("expires_at"), bool)
            or not isinstance(record["expires_at"], int)
            or record["expires_at"] < 1
        ):
            raise RuntimeError(f"admin store {STORE_PATH} has invalid host reset evidence")
        digests.add(record["digest"])
    return records


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
    def set_key(data: dict) -> None:
        records = data.setdefault("model_credentials", {})
        if not isinstance(records, dict):
            raise RuntimeError(f"admin store {STORE_PATH} has invalid model credentials")
        verified_at = int(time.time())
        records[provider] = {
            "api_key": api_key,
            "verified_at": verified_at,
        }

    _mutate(set_key)


def delete_model_api_key(provider):
    """Delete one provider key without disturbing the Admin session or other providers."""
    def delete_key(data: dict) -> bool:
        records = data.get("model_credentials", {})
        if not isinstance(records, dict):
            raise RuntimeError(f"admin store {STORE_PATH} has invalid model credentials")
        return records.pop(provider, None) is not None

    return bool(_mutate(delete_key, bool))
