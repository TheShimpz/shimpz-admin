"""Password-plus-host-capability authority for destructive Local Space reset."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import stat
import time
from functools import partial
from pathlib import Path

import auth
import state
import supervisor
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

CAPABILITY_PATH = Path(os.environ.get("SHIMPZ_HOST_RESET_CAPABILITY_FILE") or "/run/shimpz-local-reset/capability.json")
MAX_CAPABILITY_BYTES = 1024
MAX_CAPABILITY_SECONDS = 120
SPACE_ID_RE = re.compile(r"^space-[0-9a-f]{24}$")
CAPABILITY_RE = re.compile(r"^[0-9a-f]{64}$")
FIELDS = frozenset({"version", "purpose", "space_id", "created_at", "expires_at", "capability_sha256"})
log = logging.getLogger("shimpz-admin")


class HostResetCapabilityError(RuntimeError):
    """The projected host reset capability is absent, unsafe, invalid, expired, or consumed."""


def _read_bounded(path: Path) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise HostResetCapabilityError("host reset capability is unavailable") from exc
    try:
        record = os.fstat(descriptor)
        if (
            not stat.S_ISREG(record.st_mode)
            or record.st_nlink != 1
            or stat.S_IMODE(record.st_mode) != 0o600
            or record.st_uid != os.geteuid()
            or record.st_gid != os.getegid()
            or not 0 < record.st_size <= MAX_CAPABILITY_BYTES
        ):
            raise HostResetCapabilityError("host reset capability is unavailable")
        payload = os.read(descriptor, MAX_CAPABILITY_BYTES + 1)
        if len(payload) != record.st_size:
            raise HostResetCapabilityError("host reset capability is unavailable")
        return payload
    finally:
        os.close(descriptor)


def _space_id() -> str:
    value = os.environ.get("SHIMPZ_SPACE_ID", "")
    if SPACE_ID_RE.fullmatch(value) is None:
        raise HostResetCapabilityError("host reset capability is unavailable")
    return value


def verify_capability(capability: object, *, now: int | None = None) -> tuple[str, int]:
    """Validate the private file and return only its digest and expiry evidence."""
    if not isinstance(capability, str) or CAPABILITY_RE.fullmatch(capability) is None:
        raise HostResetCapabilityError("host reset capability is unavailable")
    timestamp = int(time.time()) if now is None else now
    if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 1:
        raise ValueError("invalid host reset timestamp")
    try:
        document = json.loads(_read_bounded(CAPABILITY_PATH))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HostResetCapabilityError("host reset capability is unavailable") from exc
    if not isinstance(document, dict) or set(document) != FIELDS:
        raise HostResetCapabilityError("host reset capability is unavailable")
    created_at = document["created_at"]
    expires_at = document["expires_at"]
    digest = document["capability_sha256"]
    if (
        document["version"] != 1
        or document["purpose"] != "space-reset"
        or document["space_id"] != _space_id()
        or isinstance(created_at, bool)
        or not isinstance(created_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
        or not timestamp - MAX_CAPABILITY_SECONDS <= created_at <= timestamp
        or not timestamp <= expires_at <= timestamp + MAX_CAPABILITY_SECONDS
        or not 1 <= expires_at - created_at <= MAX_CAPABILITY_SECONDS
        or not isinstance(digest, str)
        or CAPABILITY_RE.fullmatch(digest) is None
    ):
        raise HostResetCapabilityError("host reset capability is unavailable")
    presented = hashlib.sha256(bytes.fromhex(capability)).hexdigest()
    if not hmac.compare_digest(presented, digest):
        raise HostResetCapabilityError("host reset capability is unavailable")
    return digest, expires_at


def _response(status_code: int, body: dict[str, object]) -> JSONResponse:
    response = JSONResponse(body, status_code=status_code)
    response.headers["Cache-Control"] = "no-store"
    return response


def _recovery_reset_action(payload, digest: str, bootstrap_reset, established_reset):
    if set(payload) != {"capability"}:
        raise HTTPException(status_code=400, detail="recovery reset accepts only capability")
    try:
        state.local_supervisor()
    except supervisor.SupervisorAuthorityError:
        return bootstrap_reset, "host-capability-recovery"
    return partial(established_reset, digest), "host-capability-recovery"


async def reset(
    request: Request,
    *,
    setup_lock,
    read_json,
    verify_password,
    bootstrap_reset,
    established_reset,
) -> JSONResponse:
    """Consume exact host authority before invoking the matching Team deletion boundary."""
    payload = await read_json(request)
    capability = payload.get("capability")
    try:
        digest, expires_at = verify_capability(capability)
    except HostResetCapabilityError:
        log.info("Local Space host reset denied: host capability unavailable")
        raise HTTPException(status_code=403, detail="host reset authorization is unavailable") from None
    if setup_lock.locked():
        log.info("Local Space host reset deferred: setup or reset is busy")
        return _response(409, {"code": "host-reset-busy", "detail": "Supervisor setup or reset is in progress"})
    async with setup_lock:
        try:
            current = state.authentication_state()
        except auth.PasswordRecordError:
            current = None
            action, authority = _recovery_reset_action(payload, digest, bootstrap_reset, established_reset)
        else:
            action = None
            authority = ""
        if current == auth.RECORD_STATE_UNINITIALIZED:
            if set(payload) != {"capability"}:
                raise HTTPException(status_code=400, detail="uninitialized reset accepts only capability")
            action = bootstrap_reset
            authority = "host-capability"
        elif current is not None:
            if set(payload) != {"capability", "password"}:
                return _response(
                    409,
                    {"code": "supervisor-password-required", "detail": "Supervisor password is required"},
                )
            await verify_password(payload["password"])
            action = partial(established_reset, digest)
            authority = "password-and-host-capability"
        if action is None:
            raise RuntimeError("host reset authority is unavailable")
        if not state.consume_host_reset_capability(digest, expires_at):
            log.info("Local Space host reset denied: consumed host capability")
            raise HTTPException(status_code=403, detail="host reset authorization is unavailable")
        try:
            response = await run_in_threadpool(action)
        except Exception:
            log.exception("Local Space host reset failed after %s authorization", authority)
            raise
        log.info("Local Space host reset completed with %s authorization", authority)
        response.headers["Cache-Control"] = "no-store"
        return response
