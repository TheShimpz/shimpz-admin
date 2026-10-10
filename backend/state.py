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
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import auth
import supervisor
from mfa import passkeys as webauthn
from mfa import recovery, totp

from protocol.http.v1.websocket import canonical_origin

STORE_PATH = Path(os.environ.get("SHIMPZ_ADMIN_STORE") or "/data/admin.json")
_STORE_LOCK = threading.RLock()
AUTH_VERSION = 1
MAX_CONSUMED_HOST_RESETS = 128
# Refused second-factor attempts since the last successful sign-in, and those a sign-in reported that the Supervisor
# has not yet acknowledged. Both counters saturate at this bound.
MAX_SECOND_FACTOR_FAILURES = 1_000_000


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


def _fsync_directory(path: Path) -> None:
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _write(data):
    """Atomically and durably write admin.json 0600 (tmp created 0600 from birth, then renamed on same fs).

    The temporary name is random and exclusively created, so a leftover from a killed process (the
    container restarts as the same PID) can never block a later write. The file is fsynced before the
    rename and the directory after it, so an acknowledged security update (session-secret rotation,
    TOTP replay evidence, passkey counters) survives power loss; the cache updates only after both.
    """
    global _store_cache
    with _STORE_LOCK:
        if not isinstance(data, dict):
            raise RuntimeError(f"admin store {STORE_PATH} is not a JSON object")
        payload = json.dumps(data, indent=2, sort_keys=True).encode("utf-8")
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f".{STORE_PATH.name}.", suffix=".tmp", dir=STORE_PATH.parent)
        tmp = Path(name)
        try:
            try:
                # os.write may write fewer bytes than asked; only a complete payload may replace the store.
                view = memoryview(payload)
                while view:
                    view = view[os.write(fd, view) :]
                os.fsync(fd)
            finally:
                os.close(fd)
            tmp.replace(STORE_PATH)  # same filesystem (the /data volume) → atomic
            _fsync_directory(STORE_PATH.parent)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        _store_cache = _StoreCache(STORE_PATH, _store_identity(STORE_PATH), copy.deepcopy(data))


def _always_write(_result: object) -> bool:
    return True


def _mutate(
    update: Callable[[dict], object],
    should_write: Callable[[object], bool] = _always_write,
    journal: Callable[[object], None] | None = None,
) -> object:
    """Hold one lock across the complete read-modify-write transaction.

    `journal` records the transaction's outcome before anything is persisted; when it raises, nothing is written.
    """
    with _STORE_LOCK:
        data = _read()
        result = update(data)
        if should_write(result):
            if journal is not None:
                journal(result)
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
        _validated_second_factor_failures(data.get("second_factor_failures"))
        return _factor_state(totp.state(data.get("totp")), data)
    except (totp.TotpStateError, webauthn.PasskeyError, recovery.RecoveryStateError) as exc:
        raise auth.PasswordRecordError("Local Supervisor MFA record requires bounded recovery") from exc


def _factor_state(factor: str, data: dict) -> str:
    """First enrollment has no recovery codes yet; a pending TOTP beside a set is the re-enrollment a code began."""
    if "recovery_codes" not in data:
        raise recovery.RecoveryStateError("stored recovery codes are missing")
    codes = data["recovery_codes"]
    if codes is None:
        if factor != auth.RECORD_STATE_ENROLLMENT_REQUIRED:
            raise recovery.RecoveryStateError("an active TOTP factor requires recovery codes")
        return factor
    recovery.validated(codes)
    return auth.RECORD_STATE_RECOVERY_ENROLLMENT if factor == auth.RECORD_STATE_ENROLLMENT_REQUIRED else factor


def _validated_second_factor_failures(record: object) -> dict[str, int]:
    if not isinstance(record, dict) or set(record) != {"since_sign_in", "unacknowledged"}:
        raise totp.TotpStateError("stored second-factor failures are invalid")
    for value in record.values():
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SECOND_FACTOR_FAILURES:
            raise totp.TotpStateError("stored second-factor failures are invalid")
    return record


def _second_factor_refused(data: dict) -> None:
    failures = data["second_factor_failures"]
    failures["since_sign_in"] = min(failures["since_sign_in"] + 1, MAX_SECOND_FACTOR_FAILURES)


def _signed_in(data: dict) -> None:
    """A successful sign-in reports the refused attempts since the previous one until the Supervisor acknowledges."""
    failures = data["second_factor_failures"]
    failures["unacknowledged"] = min(failures["unacknowledged"] + failures["since_sign_in"], MAX_SECOND_FACTOR_FAILURES)
    failures["since_sign_in"] = 0


def unacknowledged_second_factor_failures() -> int:
    """The refused second-factor attempts that sign-ins reported and the Supervisor has not acknowledged."""
    data = _read()
    _authentication_state(data)
    return int(data["second_factor_failures"]["unacknowledged"])


def acknowledge_second_factor_failures(count: int) -> int:
    """Acknowledge `count` reported failures, never more than are reported, and return how many remain."""

    def acknowledge(data: dict) -> int:
        if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED:
            raise auth.PasswordRecordError("Local Supervisor authentication is not configured")
        failures = data["second_factor_failures"]
        failures["unacknowledged"] = max(failures["unacknowledged"] - count, 0)
        return int(failures["unacknowledged"])

    return cast(int, _mutate(acknowledge))


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


def classified_authentication_state() -> str:
    """Project the public state, classifying only an invalid auth record for recovery.

    A re-enrollment that a recovery code began is presented as `configured`: its only way forward is signing in again.
    """
    try:
        current = authentication_state()
    except auth.PasswordRecordError:
        return auth.RECORD_STATE_RECOVERY_REQUIRED
    return auth.RECORD_STATE_CONFIGURED if current == auth.RECORD_STATE_RECOVERY_ENROLLMENT else current


def revoke_sessions_for_logout(session_token: object) -> bool:
    """Rotate every Local session only when the presented session is currently valid."""

    def revoke(data: dict) -> bool:
        if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED:
            return False
        if not isinstance(session_token, str) or auth.verify_session(data["session_secret"], session_token) is None:
            return False
        data["session_secret"] = auth.new_secret()
        return True

    return bool(_mutate(revoke, bool))


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
        data["second_factor_failures"] = {"since_sign_in": 0, "unacknowledged": 0}
        data["recovery_codes"] = None
        data["created"] = int(time.time()) if now is None else now
        return totp.enrollment(data["totp"])

    return cast(totp.Enrollment, _mutate(begin))


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
    return [copy.deepcopy(record) for record in active if record["origin"] == origin and record["rp_id"] == rp_id]


def passkey_for_authentication(credential_id: str, origin: str) -> dict[str, object]:
    """Select one active exact-origin credential without exposing it through HTTP."""
    matches = [record for record in active_passkeys(origin) if record["credential_id"] == credential_id]
    if len(matches) != 1:
        raise webauthn.PasskeyUnavailableError("invalid passkey authentication")
    return matches[0]


def add_passkey(record: dict[str, object], generation: int, *, journal: Callable[[object], None] | None = None) -> str:
    """Persist one verified credential and rotate all existing sessions, journaling it first."""
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

    return str(_mutate(add, journal=journal))


def commit_passkey_authentication(
    original: dict[str, object],
    result: webauthn.Authentication,
    generation: int,
    *,
    now: int,
    sign_in: bool = False,
    journal: Callable[[object], None] | None = None,
) -> tuple[str, str | None]:
    """Commit one assertion update or suspension against the exact original record, journaling its outcome first.

    A `sign_in` assertion that is accepted also completes a sign-in.
    """
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
        identity_changed = result.backup_eligible != record["backup_eligible"] or (
            result.backup_state and not result.backup_eligible
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
        if sign_in:
            _signed_in(data)
        return str(data["session_secret"]), None

    return cast(tuple[str, str | None], _mutate(commit, journal=journal))


# What each TOTP ceremony requires of the current state, and whether an accepted code completes an enrollment.
_TOTP_CEREMONIES = {
    "setup": (auth.RECORD_STATE_ENROLLMENT_REQUIRED, True),
    "recovery": (auth.RECORD_STATE_RECOVERY_ENROLLMENT, True),
    "login": (auth.RECORD_STATE_CONFIGURED, False),
    "operation": (auth.RECORD_STATE_CONFIGURED, False),
}


def verify_totp(
    code: object,
    *,
    ceremony: str,
    now: int | None = None,
    generation: int | None = None,
    codes: dict[str, object] | None = None,
    journal: Callable[[object], None] | None = None,
) -> totp.Verification:
    """Persist one TOTP attempt, activation, replay evidence, and session rotation, journaling its outcome first.

    A ceremony passes the factor generation its password ticket was issued under, checked inside the same transaction.
    Every refused code counts as a failed second-factor attempt. An accepted `setup` or `recovery` code activates the
    pending factor with the fresh recovery `codes`, and with `login` it completes a sign-in.
    """
    expected, enrolls = _TOTP_CEREMONIES[ceremony]
    if enrolls:
        recovery.validated(codes)

    def verify(data: dict) -> totp.Verification:
        if _authentication_state(data) != expected:
            raise totp.TotpStateError("TOTP ceremony is unavailable")
        if generation is not None and data["factor_generation"] != generation:
            return totp.Verification.CHANGED
        result = totp.verify(data["totp"], code, now)
        if result in {totp.Verification.INVALID, totp.Verification.LOCKED}:
            _second_factor_refused(data)
        elif result is totp.Verification.ACCEPTED and ceremony != "operation":
            _signed_in(data)
        if result is totp.Verification.ACCEPTED and enrolls:
            data["recovery_codes"] = copy.deepcopy(codes)
            data["factor_generation"] = int(data["factor_generation"]) + 1
            data["session_secret"] = auth.new_secret()
        return result

    return cast(totp.Verification, _mutate(verify, journal=journal))


_RECOVERY_STATES = frozenset({auth.RECORD_STATE_CONFIGURED, auth.RECORD_STATE_RECOVERY_ENROLLMENT})


def recovery_candidate(typed: object) -> recovery.Candidate:
    """Derive a typed recovery code under the current set's salt, before the transaction that spends it."""
    data = _read()
    if _authentication_state(data) not in _RECOVERY_STATES:
        raise totp.TotpStateError("recovery codes are unavailable")
    return recovery.candidate(data["recovery_codes"], typed)


def spend_recovery_code(
    derived: recovery.Candidate,
    *,
    generation: int,
    now: int | None = None,
    journal: Callable[[object], None] | None = None,
) -> tuple[totp.Verification, totp.Enrollment | None]:
    """Spend one recovery code under the TOTP failure budget, journaling the outcome before it is persisted.

    An accepted code replaces TOTP with a fresh pending factor, rotates the session secret so every session ends, and
    admits only that factor's re-enrollment, whose secret it returns. A refused code counts as a refused second factor.
    """
    timestamp = int(time.time()) if now is None else now

    def spend(data: dict) -> tuple[totp.Verification, totp.Enrollment | None]:
        if _authentication_state(data) not in _RECOVERY_STATES:
            raise totp.TotpStateError("recovery codes are unavailable")
        if data["factor_generation"] != generation or data["recovery_codes"]["salt"] != derived.salt:
            return totp.Verification.CHANGED, None
        factor = data["totp"]
        if totp.locked(factor, timestamp):
            _second_factor_refused(data)
            return totp.Verification.LOCKED, None
        if not recovery.spend(data["recovery_codes"], derived, timestamp):
            _second_factor_refused(data)
            return totp.record_failure(factor, timestamp), None
        data["totp"] = totp.new_record(timestamp)
        data["factor_generation"] = generation + 1
        data["session_secret"] = auth.new_secret()
        return totp.Verification.ACCEPTED, totp.enrollment(data["totp"])

    # A ceremony from before a factor change spends nothing and leaves nothing to journal.
    outcome = _mutate(spend, lambda result: result[0] is not totp.Verification.CHANGED, journal)
    return cast(tuple[totp.Verification, totp.Enrollment | None], outcome)


def replace_recovery_codes(codes: dict[str, object], *, journal: Callable[[object], None] | None = None) -> None:
    """Replace the whole set with a fresh one, journaling it first; every code of the previous set stops working."""
    recovery.validated(codes)

    def replace(data: dict) -> None:
        if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED:
            raise totp.TotpStateError("recovery codes are unavailable")
        data["recovery_codes"] = copy.deepcopy(codes)
        data["factor_generation"] = int(data["factor_generation"]) + 1

    _mutate(replace, journal=journal)


def recovery_codes_remaining() -> int:
    """How many of the current recovery codes are still unused."""
    data = _read()
    if _authentication_state(data) != auth.RECORD_STATE_CONFIGURED:
        raise totp.TotpStateError("recovery codes are unavailable")
    return recovery.remaining(data["recovery_codes"])


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


# The new Supervisor signing key a rotation saved durably beside the current one until Team answers (ADR-0051).
PENDING_KEY_FIELD = "supervisor_pending_signing_key"


class SupervisorKeyRotationError(RuntimeError):
    """The rotation's pending key is not the one the caller holds, or the Supervisor is not configured."""


def pending_supervisor_key() -> supervisor.LocalIdentity | None:
    """The Supervisor's pending signing key, under the current Supervisor id, or None when no rotation is open."""
    data = _read()
    if PENDING_KEY_FIELD not in data:
        return None
    current = supervisor.identity_from_record(data)
    pending = supervisor.identity_from_record(data, key_field=PENDING_KEY_FIELD)
    if pending.private_key_hex == current.private_key_hex:
        raise supervisor.SupervisorAuthorityError("Local Supervisor pending key is invalid")
    return pending


def begin_supervisor_key_rotation(
    pending: supervisor.LocalIdentity, *, journal: Callable[[object], None] | None = None
) -> None:
    """Durably save a new signing key beside the current one, journaling it first; one rotation is open at a time."""

    def begin(data: dict) -> None:
        current = supervisor.identity_from_record(data)
        if (
            _authentication_state(data) != auth.RECORD_STATE_CONFIGURED
            or PENDING_KEY_FIELD in data
            or pending.supervisor_id != current.supervisor_id
            or pending.private_key_hex == current.private_key_hex
        ):
            raise SupervisorKeyRotationError("a Supervisor key rotation cannot begin")
        supervisor.identity_from_record(
            {"supervisor_id": pending.supervisor_id, "supervisor_signing_key": pending.private_key_hex}
        )
        data[PENDING_KEY_FIELD] = pending.private_key_hex

    _mutate(begin, journal=journal)


def _settle_rotation(pending: supervisor.LocalIdentity, adopt: bool, journal: Callable[[object], None] | None) -> None:
    def settle(data: dict) -> None:
        if data.get(PENDING_KEY_FIELD) != pending.private_key_hex:
            raise SupervisorKeyRotationError("the Supervisor key rotation is no longer open")
        if adopt:
            # The earlier key is overwritten in the same atomic write that makes the new one current.
            data["supervisor_signing_key"] = data[PENDING_KEY_FIELD]
        del data[PENDING_KEY_FIELD]

    _mutate(settle, journal=journal)


def adopt_supervisor_key(pending: supervisor.LocalIdentity, *, journal: Callable[[object], None] | None = None) -> None:
    """Team pins the pending key now: make it current and drop the earlier one, journaling it first."""
    _settle_rotation(pending, True, journal)


def abandon_supervisor_key(
    pending: supervisor.LocalIdentity, *, journal: Callable[[object], None] | None = None
) -> None:
    """Team kept the current key: drop the pending one, journaling it first."""
    _settle_rotation(pending, False, journal)


_ROUTINE_FIELDS = {"id_field": "routine_subject", "key_field": "routine_signing_key"}


def local_routine_identity() -> supervisor.LocalIdentity:
    """Admin's machine identity for Routine runs (ADR-0086), created with the Space's first need for it.

    It exists only beside an established Supervisor identity, and a Space reset, which removes this record, replaces
    it, so every lease claimed under the old key ends.
    """

    def ensure(data: dict) -> supervisor.LocalIdentity:
        supervisor.identity_from_record(data)
        if "routine_subject" not in data and "routine_signing_key" not in data:
            identity = supervisor.new_identity()
            data["routine_subject"] = identity.supervisor_id
            data["routine_signing_key"] = identity.private_key_hex
        return supervisor.identity_from_record(data, **_ROUTINE_FIELDS)

    def created(_identity: object) -> bool:
        current = _read()
        return "routine_subject" not in current

    return cast(supervisor.LocalIdentity, _mutate(ensure, created))


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


def decision_credential() -> dict[str, object] | None:
    """Return the private TypeSafe decision-key record for trusted backend callers only (ADR-0077)."""
    record = _read().get("decision_credential")
    if record is not None and not isinstance(record, dict):
        raise RuntimeError(f"admin store {STORE_PATH} has an invalid decision credential")
    return record


def set_decision_api_key(api_key: str) -> None:
    """Atomically persist the remotely verified TypeSafe key in the 0600 Admin store."""

    def set_key(data: dict) -> None:
        data["decision_credential"] = {"api_key": api_key, "verified_at": int(time.time())}

    _mutate(set_key)


def delete_decision_api_key() -> None:
    """Delete the TypeSafe key without disturbing model keys or the Admin session."""
    _mutate(lambda data: data.pop("decision_credential", None))
