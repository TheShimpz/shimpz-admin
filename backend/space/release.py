"""Read the bounded Local platform-release status projected by the release-bound CLI."""

import json
import os
import re
import stat
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException

STATUS_PATH = Path("/run/shimpz-local-release/status.json")
MAX_STATUS_BYTES = 1024
# A published release set, or a developer release built on this host (ADR-0099).
RELEASE = re.compile(r"(?:ghcr\.io/theshimpz|localhost)/shimpz-local-release@sha256:[0-9a-f]{64}")
# 9999-12-31T23:59:59Z keeps every accepted Unix second inside the datetime range.
MAX_CHECKED_AT = 253_402_300_799
OUTCOMES = frozenset({"current", "updated", "rollback-needed"})
FIELDS = frozenset({"release", "ordinal", "checked_at", "outcome"})


class PlatformReleaseUnavailableError(RuntimeError):
    """The CLI status is absent or fails its closed projection contract."""


def _read_bounded(path: Path) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
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
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_CHECKED_AT


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
        or not isinstance(outcome, str)
        or outcome not in OUTCOMES
    ):
        raise PlatformReleaseUnavailableError
    return document


def status_response() -> dict[str, object]:
    try:
        document = read_status()
    except PlatformReleaseUnavailableError as exc:
        raise HTTPException(status_code=503, detail="Local platform release status is unavailable") from exc
    checked_at = datetime.fromtimestamp(document["checked_at"], UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {**document, "checked_at": checked_at}


def register(application: FastAPI, profile: str) -> None:
    if profile == "local":
        application.add_api_route("/api/platform-release", status_response, methods=["GET"])
