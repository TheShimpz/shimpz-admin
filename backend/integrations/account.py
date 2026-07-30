"""Fail-closed Hosted Admin adapter for Account identity sessions."""

from __future__ import annotations

import asyncio
import concurrent.futures
import http.client
import json
import logging
import os
import re
import stat
import threading
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_ACCOUNT_URL", "http://accounts:7079")
SESSION_TOKEN_FILE = Path(
    os.environ.get(
        "SHIMPZ_ACCOUNT_ADMIN_SESSION_TOKEN_FILE",
        "/run/shimpz-account-admin-session/token",
    )
)
CONTROL_TIMEOUT_SECONDS = 10
MAX_REQUEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 8 * 1024
_CAPABILITY = re.compile(rb"[0-9a-f]{64}\Z")
_ACCOUNT_ID = re.compile(r"[0-9a-f]{32}\Z")
_USERNAME = re.compile(r"[a-z0-9][a-z0-9-]{1,30}[a-z0-9]\Z")


class ExecutorSaturatedError(RuntimeError):
    """The finite Account-call worker and queue budget has no free slot."""


class _BoundedExecutor(concurrent.futures.ThreadPoolExecutor):
    def __init__(self) -> None:
        self._permits = threading.BoundedSemaphore(8)
        super().__init__(max_workers=4, thread_name_prefix="shimpz-account-session")

    def submit(self, fn, /, *args, **kwargs):
        if not self._permits.acquire(blocking=False):
            raise ExecutorSaturatedError("Account session worker admission is full")
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self._permits.release()
            raise
        future.add_done_callback(lambda _completed: self._permits.release())
        return future


@dataclass(frozen=True)
class AccountResponse:
    status: int
    body: dict[str, object]


EXECUTOR = _BoundedExecutor()


def _endpoint() -> tuple[str, int]:
    try:
        parsed = urlparse(URL)
        port = parsed.port or 7079
    except ValueError as exc:
        raise OSError("invalid Account endpoint") from exc
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
        or not 1 <= port <= 65535
    ):
        raise OSError("invalid Account endpoint")
    return parsed.hostname, port


def _session_capability() -> str:
    descriptor: int | None = None
    try:
        descriptor = os.open(
            SESSION_TOKEN_FILE,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o440:
            return ""
        raw = os.read(descriptor, 65)
    except OSError, ValueError:
        return ""
    finally:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)
    return raw.decode("ascii") if _CAPABILITY.fullmatch(raw) is not None else ""


def _payload(value: dict[str, object]) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid Account request") from exc
    if len(encoded) > MAX_REQUEST_BYTES:
        raise OSError("invalid Account request")
    return encoded


def _response_body(response: http.client.HTTPResponse) -> dict[str, object]:
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise OSError("invalid Account response")
    raw_length = response.getheader("Content-Length")
    if raw_length is not None and (
        not raw_length.isascii() or not raw_length.isdecimal() or int(raw_length) > MAX_RESPONSE_BYTES
    ):
        raise OSError("invalid Account response")
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if not raw or len(raw) > MAX_RESPONSE_BYTES:
        raise OSError("invalid Account response")
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid Account response") from exc
    if not isinstance(body, dict):
        raise OSError("invalid Account response")
    return body


def _call(
    path: str,
    payload: dict[str, object],
    *,
    capability: bool = False,
    client_ip: str = "",
) -> AccountResponse:
    connection = None
    try:
        host, port = _endpoint()
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if capability:
            token = _session_capability()
            if not token:
                raise OSError("Account session capability is unavailable")
            headers["Authorization"] = f"Bearer {token}"
        if client_ip:
            headers["X-Forwarded-For"] = client_ip
        body = _payload(payload)
        connection = http.client.HTTPConnection(host, port, timeout=CONTROL_TIMEOUT_SECONDS)
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid Account status")
        result = AccountResponse(response.status, _response_body(response))
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("Account identity request failed")
        return AccountResponse(502, {"error": "Account identity is unavailable"})
    finally:
        if connection is not None:
            with suppress(OSError):
                connection.close()
    return result


def login(username: str, password: str, client_ip: str) -> AccountResponse:
    response = _call(
        "/v1/login",
        {"username": username, "password": password},
        client_ip=client_ip,
    )
    if response.status != 200:
        return response
    body = response.body
    if (
        set(body) != {"account_id", "username", "token"}
        or not isinstance(body["account_id"], str)
        or _ACCOUNT_ID.fullmatch(body["account_id"]) is None
        or not isinstance(body["username"], str)
        or _USERNAME.fullmatch(body["username"]) is None
        or not isinstance(body["token"], str)
        or not 1 <= len(body["token"]) <= 2048
        or any(not 0x20 <= ord(character) <= 0x7E for character in body["token"])
    ):
        return AccountResponse(502, {"error": "Account identity returned an invalid response"})
    return response


def logout(token: str) -> AccountResponse:
    response = _call("/v1/logout", {"token": token})
    if response.status == 200 and response.body != {"logged_out": True}:
        return AccountResponse(502, {"error": "Account identity returned an invalid response"})
    return response


def introspect(token: str) -> AccountResponse:
    response = _call(
        "/v1/internal/admin/sessions/introspect",
        {"version": 1, "token": token},
        capability=True,
    )
    if response.status != 200:
        return response
    body = response.body
    expected = (
        {"version", "active", "account_id", "supervisor"}
        if body.get("active") is True
        else {
            "version",
            "active",
        }
    )
    if (
        set(body) != expected
        or type(body.get("version")) is not int
        or body["version"] != 1
        or not isinstance(body.get("active"), bool)
        or (
            body["active"]
            and (
                not isinstance(body["account_id"], str)
                or _ACCOUNT_ID.fullmatch(body["account_id"]) is None
                or not isinstance(body["supervisor"], bool)
            )
        )
    ):
        return AccountResponse(502, {"error": "Account identity returned an invalid response"})
    return response


def verify_sudo_password(token: str, password: str, client_ip: str) -> AccountResponse:
    response = _call(
        "/v1/security/sudo/password",
        {"token": token, "password": password},
        client_ip=client_ip,
    )
    if response.status == 200:
        body = response.body
        if (
            set(body) != {"verified", "amr", "strong_auth_at"}
            or body["verified"] is not True
            or not isinstance(body["amr"], list)
            or not isinstance(body["strong_auth_at"], int)
            or isinstance(body["strong_auth_at"], bool)
        ):
            return AccountResponse(502, {"error": "Account identity returned an invalid response"})
    return response


async def run_bounded(operation, /, *args) -> AccountResponse:
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(EXECUTOR, operation, *args)
    except ExecutorSaturatedError:
        return AccountResponse(503, {"error": "Account identity is busy"})
