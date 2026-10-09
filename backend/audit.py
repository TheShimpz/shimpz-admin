"""The durable, metadata-only journal of Local Supervisor authentication events.

Each event is appended and synchronized before the authentication state change it describes, so a refused write
refuses the change: no session, browser origin, passkey, logout, or reset proceeds unaudited. A failure is sticky for
the life of the process, because after a failed write or `fsync` the journal's durable content is unknown; Admin answers
every later authentication change as unavailable until it restarts. A line holds only the time, the event, its outcome,
the exact browser origin, and the second-factor method: never a password, code, credential, ticket, session, capability,
or digest.
"""

import json
import os
import stat
import threading
import time
from pathlib import Path

import state

from protocol.http.v1.websocket import canonical_origin

FILE_NAME = "audit.jsonl"
MAX_BYTES = 1024 * 1024
BACKUPS = 2
EVENTS = frozenset(
    {
        "setup-started",
        "setup-completed",
        "password-rejected",
        "password-locked",
        "totp-rejected",
        "totp-locked",
        "passkey-rejected",
        "passkey-suspended",
        "passkey-registered",
        "login",
        "origin-learned",
        "origin-replaced",
        "operation-confirmed",
        "logout",
        "host-reset",
    }
)
OUTCOMES = frozenset({"ok", "denied"})
METHODS = frozenset({"totp", "passkey"})


class AuditUnavailableError(RuntimeError):
    """The authentication journal cannot durably record an event, so the change it describes is refused."""


_LOCK = threading.Lock()
_failure: AuditUnavailableError | None = None


def path() -> Path:
    """The journal beside `admin.json` on Admin's private data volume."""
    return state.STORE_PATH.with_name(FILE_NAME)


def _safe(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_nlink == 1
        and metadata.st_uid == os.geteuid()
        and stat.S_IMODE(metadata.st_mode) == 0o600
    )


def _sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _rotate(journal: Path) -> None:
    """Keep the newest `BACKUPS` full journals beside the current one, refusing any unsafe file among them."""
    for index in range(BACKUPS, 0, -1):
        source = journal.with_name(f"{journal.name}.{index - 1}") if index > 1 else journal
        if source.exists():
            if not _safe(source.lstat()):
                raise AuditUnavailableError("the authentication journal has unsafe metadata")
            source.replace(journal.with_name(f"{journal.name}.{index}"))
    _sync_directory(journal.parent)


def _append(journal: Path, line: bytes) -> None:
    journal.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if journal.exists() and journal.lstat().st_size + len(line) > MAX_BYTES:
        _rotate(journal)
    created = not journal.exists()
    descriptor = os.open(journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if not _safe(os.fstat(descriptor)):
            raise AuditUnavailableError("the authentication journal has unsafe metadata")
        view = memoryview(line)
        while view:
            view = view[os.write(descriptor, view) :]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if created:
        _sync_directory(journal.parent)


def record(event: str, *, outcome: str, origin: str | None = None, method: str | None = None) -> None:
    """Durably append one event, or raise `AuditUnavailableError` so its caller refuses the change."""
    if (
        event not in EVENTS
        or outcome not in OUTCOMES
        or (origin is not None and canonical_origin(origin) != origin)
        or (method is not None and method not in METHODS)
    ):
        raise ValueError("invalid authentication audit event")
    entry: dict[str, object] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
        "outcome": outcome,
        "origin": origin,
    }
    if method is not None:
        entry["method"] = method
    line = (json.dumps(entry, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")
    global _failure
    with _LOCK:
        if _failure is not None:
            raise _failure
        try:
            _append(path(), line)
        except (OSError, AuditUnavailableError) as exc:
            _failure = AuditUnavailableError("the authentication journal could not be written")
            raise _failure from exc
