"""Read the bounded Local platform-release status projected by the host reconciler."""

import json
import os
import re
import stat
from datetime import UTC, datetime
from pathlib import Path

STATUS_PATH = Path("/run/shimpz-local-release/status.json")
MAX_STATUS_BYTES = 1024
RELEASE = re.compile(r"ghcr\.io/theshimpz/shimpz-local-release@sha256:[0-9a-f]{64}")
TIMESTAMP = re.compile(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
OUTCOMES = frozenset({"current", "updated", "rollback-needed"})
FIELDS = frozenset({"release", "ordinal", "checked_at", "outcome"})


class PlatformReleaseUnavailableError(RuntimeError):
    """The reconciler status is absent or fails its closed projection contract."""


def _read_bounded(path: Path) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise PlatformReleaseUnavailableError from exc
    try:
        record = os.fstat(descriptor)
        if (
            not stat.S_ISREG(record.st_mode)
            or stat.S_IMODE(record.st_mode) != 0o600
            or record.st_uid != os.geteuid()
            or record.st_size <= 0
            or record.st_size > MAX_STATUS_BYTES
        ):
            raise PlatformReleaseUnavailableError
        payload = os.read(descriptor, MAX_STATUS_BYTES + 1)
        if len(payload) != record.st_size:
            raise PlatformReleaseUnavailableError
        return payload
    finally:
        os.close(descriptor)


def _valid_timestamp(value: object) -> bool:
    if not isinstance(value, str) or TIMESTAMP.fullmatch(value) is None:
        return False
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC).isoformat() != ""
    except ValueError:
        return False


def read_status(path: Path = STATUS_PATH) -> dict[str, object]:
    try:
        document = json.loads(_read_bounded(path))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PlatformReleaseUnavailableError from exc
    if not isinstance(document, dict) or set(document) != FIELDS:
        raise PlatformReleaseUnavailableError
    release = document["release"]
    ordinal = document["ordinal"]
    outcome = document["outcome"]
    if (
        not isinstance(release, str)
        or RELEASE.fullmatch(release) is None
        or not isinstance(ordinal, int)
        or isinstance(ordinal, bool)
        or ordinal <= 0
        or not _valid_timestamp(document["checked_at"])
        or outcome not in OUTCOMES
    ):
        raise PlatformReleaseUnavailableError
    return document
