"""The durable, metadata-only journal of Local Supervisor authentication events.

Each event is appended and synchronized before the authentication state change it describes, so a refused write
refuses the change: no session, browser origin, passkey, logout, or reset proceeds unaudited. A failure is sticky for
the life of the process, because after a failed write or `fsync` the journal's durable content is unknown; Admin answers
every later authentication change as unavailable until it restarts. A line holds only the time, the event, its outcome,
the exact browser origin, and the second-factor method: never a password, code, credential, ticket, session, capability,
or digest.
"""

import calendar
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
        "recovery-code-used",
        "recovery-code-rejected",
        "recovery-code-locked",
        "recovery-completed",
        "recovery-codes-generated",
        "logout",
        "host-reset",
        "space-reset",
    }
)
OUTCOMES = frozenset({"ok", "denied"})
# The events that complete a sign-in, and the refused attempts to sign in, for the Supervisor's sign-in history.
SIGN_INS = frozenset({"login", "setup-completed", "recovery-completed"})
SIGN_IN_FAILURES = frozenset(
    {
        "password-rejected",
        "password-locked",
        "totp-rejected",
        "totp-locked",
        "passkey-rejected",
        "passkey-suspended",
        "recovery-code-rejected",
        "recovery-code-locked",
    }
)
_TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
METHODS = frozenset({"totp", "passkey", "recovery-code"})


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
        "ts": time.strftime(_TIME_FORMAT, time.gmtime()),
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


class HistoryUnavailableError(RuntimeError):
    """The journal cannot be read back as the exact lines Admin wrote."""


def _read_journal(journal: Path) -> list[bytes]:
    """The complete lines of one journal file; a final line cut short by a crash was never acknowledged."""
    try:
        descriptor = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return []
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not _safe(metadata) or metadata.st_size > 2 * MAX_BYTES:
            raise HistoryUnavailableError("the authentication journal has unsafe metadata")
        lines = handle.read(2 * MAX_BYTES + 1).split(b"\n")
    return lines[:-1]


def _entry(line: bytes) -> tuple[int, dict[str, object]]:
    try:
        entry = json.loads(line.decode("ascii"))
        moment = calendar.timegm(time.strptime(entry["ts"], _TIME_FORMAT))
    except (ValueError, TypeError, KeyError, UnicodeDecodeError) as exc:
        raise HistoryUnavailableError("the authentication journal holds an unreadable line") from exc
    origin = entry.get("origin") if isinstance(entry, dict) else None
    if (
        not isinstance(entry, dict)
        or entry.get("event") not in EVENTS
        or (origin is not None and (not isinstance(origin, str) or canonical_origin(origin) != origin))
    ):
        raise HistoryUnavailableError("the authentication journal holds an unreadable line")
    return moment, entry


def sign_in_history(signed_in_at: int) -> dict[str, object]:
    """The sign-in before the one at `signed_in_at`, and the refused attempts to sign in between the two.

    The current sign-in is the latest journaled one at or before `signed_in_at`; one made later, from another browser,
    is not the reader's own. With no earlier sign-in kept in the journal and its backups, `previous` is None.
    """
    journal = path()
    with _LOCK:
        files = [journal.with_name(f"{journal.name}.{index}") for index in range(BACKUPS, 0, -1)] + [journal]
        entries = [_entry(line) for file in files for line in _read_journal(file)]
    sign_ins = [
        index
        for index, (moment, entry) in enumerate(entries)
        if entry["event"] in SIGN_INS and entry.get("outcome") == "ok" and moment <= signed_in_at
    ]
    if len(sign_ins) < 2:
        return {"previous": None, "failures_since": 0}
    previous, current = sign_ins[-2], sign_ins[-1]
    moment, signed_in = entries[previous]
    failures = sum(attempt["event"] in SIGN_IN_FAILURES for _moment, attempt in entries[previous + 1 : current])
    return {
        "previous": {"at": time.strftime(_TIME_FORMAT, time.gmtime(moment)), "origin": signed_in.get("origin")},
        "failures_since": failures,
    }
