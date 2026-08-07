"""Bounded authenticated HTTP transport from Admin to team."""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import os
import threading
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote, urlparse

import models
import supervisor as local_supervisor

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import progress as progress_contract
from protocol.http.v1 import supervisor as supervisor_contract

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_TEAM_URL", "http://team:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_TEAM_TOKEN_FILE", "/run/shimpz-team/token")

MAX_JSON_BODY_BYTES = 16 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
MAX_ASSISTANT_ICON_BYTES = 1024 * 1024
CONTROL_TIMEOUT_SECONDS = 180
FILE_NAME_HEADER = "X-Shimpz-Filename"


@dataclass(frozen=True, slots=True)
class _SupervisorSession:
    value: str
    account: bool
    local_identity: local_supervisor.LocalIdentity | None


@dataclass(frozen=True, slots=True, repr=False)
class _RequestBindings:
    model_credential: tuple[str, str] | None = None
    human_assurance: dict[str, str] | None = None


_SUPERVISOR_SESSION: ContextVar[_SupervisorSession | None] = ContextVar(
    "shimpz_supervisor_session",
    default=None,
)


class TeamRequestError(ValueError):
    """The browser supplied an invalid id or request body; no Team call was made."""


@dataclass(frozen=True)
class TeamResponse:
    status: int
    body: dict[str, object]


@dataclass(frozen=True)
class TeamAssetResponse:
    status: int
    contents: bytes | None
    error: dict[str, object]


ProgressSink = Callable[[dict[str, object]], None]


@dataclass(frozen=True)
class _TokenCache:
    path: Path
    identity: tuple[int, int, int, int]
    token: str


_token_cache_lock = threading.Lock()
_token_cache: _TokenCache | None = None


@contextmanager
def supervisor_session(
    value: object,
    *,
    account: bool,
    local_identity: local_supervisor.LocalIdentity | None = None,
):
    """Bind one already-validated human session to downstream Team calls in this request."""
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 2048
        or not value.isascii()
        or any(not 0x20 <= ord(character) <= 0x7E for character in value)
    ):
        raise TeamRequestError("Supervisor session is unavailable")
    if type(account) is not bool:
        raise TeamRequestError("Supervisor session kind is invalid")
    if account:
        if local_identity is not None:
            raise TeamRequestError("Hosted Supervisor session cannot carry a Local identity")
    else:
        try:
            validated = local_supervisor.identity_from_record(
                {
                    "supervisor_id": local_identity.supervisor_id,
                    "supervisor_signing_key": local_identity.private_key_hex,
                }
            )
        except (AttributeError, local_supervisor.SupervisorAuthorityError) as exc:
            raise TeamRequestError("Local Supervisor identity is unavailable") from exc
        local_identity = validated
    reset = _SUPERVISOR_SESSION.set(_SupervisorSession(value, account, local_identity))
    try:
        yield
    finally:
        _SUPERVISOR_SESSION.reset(reset)


def _account_session() -> str:
    binding = _SUPERVISOR_SESSION.get()
    return binding.value if binding is not None and binding.account else ""


def _local_assertion(
    method: str,
    path: str,
    body: bytes | None,
    *,
    content_type: str | None,
    filename: str | None,
    bindings: _RequestBindings,
) -> str:
    binding = _SUPERVISOR_SESSION.get()
    if binding is None or binding.account:
        return ""
    if binding.local_identity is None:
        raise local_supervisor.SupervisorAuthorityError("Local Supervisor identity is unavailable")
    if filename is not None:
        if body is None or content_type is None:
            raise local_supervisor.SupervisorAuthorityError("Local Supervisor file binding is invalid")
        body_binding = local_supervisor.file_body(body, filename, content_type)
    elif body is not None:
        body_binding = local_supervisor.json_body(body)
    else:
        body_binding = local_supervisor.empty_body()
    return local_supervisor.sign_request(
        binding.local_identity,
        binding.value,
        request=local_supervisor.RequestBinding(
            method=method,
            path=path,
            body=body_binding,
            model=local_supervisor.model_binding(bindings.model_credential),
            assurance=bindings.human_assurance,
        ),
    )


def _token_identity(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def _read_token_file(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _team_token() -> str:
    global _token_cache
    path = Path(TOKEN_FILE)
    identity = _token_identity(path)
    with _token_cache_lock:
        if _token_cache is not None and (_token_cache.path, _token_cache.identity) == (path, identity):
            return _token_cache.token
        token = _read_token_file(path)
        if not token:
            raise OSError("empty team bearer")
        if _token_identity(path) != identity:
            raise OSError("team bearer changed while reading")
        _token_cache = _TokenCache(path, identity, token)
        return token


def _encode_payload(payload: object | None, *, max_bytes: int = MAX_JSON_BODY_BYTES) -> bytes | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise TeamRequestError("request body must be a JSON object")
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise TeamRequestError("request body must be valid JSON") from exc
    if len(body) > max_bytes:
        raise TeamRequestError(f"request body exceeds {max_bytes} bytes")
    return body


def _endpoint() -> tuple[str, int]:
    try:
        parsed = urlparse(URL)
    except ValueError as exc:
        raise OSError("invalid team endpoint") from exc
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise OSError("invalid team endpoint")
    try:
        return parsed.hostname, parsed.port or 7077
    except ValueError as exc:
        raise OSError("invalid team endpoint") from exc


def _decode_response(response: http.client.HTTPResponse) -> dict[str, object]:
    if response.status == 204:
        raw_length = response.getheader("Content-Length")
        if raw_length not in {None, "0"} or response.read(1):
            raise OSError("invalid team response")
        return {}

    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise OSError("invalid team response")

    raw_length = response.getheader("Content-Length")
    if raw_length is not None:
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise OSError("invalid team response") from exc
        if length < 0 or length > MAX_JSON_RESPONSE_BYTES:
            raise OSError("invalid team response")

    raw = response.read(MAX_JSON_RESPONSE_BYTES + 1)
    if len(raw) > MAX_JSON_RESPONSE_BYTES:
        raise OSError("invalid team response")
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid team response") from exc
    if not isinstance(body, dict):
        raise OSError("invalid team response")
    return body


def _request_headers(
    method: str,
    path: str,
    body: bytes | None,
    *,
    accept: str,
    content_type: str | None,
    filename: str | None,
    bindings: _RequestBindings,
) -> dict[str, str]:
    headers = {"Accept": accept, "Authorization": f"Bearer {_team_token()}"}
    account_session = _account_session()
    if account_session:
        headers[team_contract.ACCOUNT_SESSION_HEADER] = account_session
    if content_type is not None:
        headers["Content-Type"] = content_type
    if filename is not None:
        headers[FILE_NAME_HEADER] = quote(filename, safe="")
    if bindings.model_credential is not None:
        provider, api_key = bindings.model_credential
        encoded_key = api_key.encode("ascii") if isinstance(api_key, str) and api_key.isascii() else b""
        if (
            provider not in models.PROVIDERS
            or not 16 <= len(encoded_key) <= 8 * 1024
            or any(not 33 <= byte <= 126 for byte in encoded_key)
        ):
            raise OSError("invalid private model credential")
        headers["X-Shimpz-Model-Provider"] = provider
        headers["X-Shimpz-Model-Api-Key"] = api_key
    assertion = _local_assertion(
        method,
        path,
        body,
        content_type=content_type,
        filename=filename,
        bindings=bindings,
    )
    if assertion:
        headers[supervisor_contract.ASSERTION_HEADER] = f"Bearer {assertion}"
    return headers


def _request(
    method: str,
    path: str,
    body: bytes | None,
    *,
    content_type: str | None,
    filename: str | None,
    timeout: int,
    model_credential: tuple[str, str] | None = None,
) -> TeamResponse:
    try:
        host, port = _endpoint()
        headers = _request_headers(
            method,
            path,
            body,
            accept="application/json",
            content_type=content_type,
            filename=filename,
            bindings=_RequestBindings(model_credential),
        )
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("team request failed (%s)", method)
        return TeamResponse(502, {"detail": "team unavailable"})
    try:
        # Deliberately request-scoped: Admin calls can run concurrently, while a shared HTTP/1.1
        # socket would require serialization and could retain an authenticated connection across
        # bearer rotation. The local bridge avoids a TLS handshake, so isolation wins over pooling.
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid team status")
        result = TeamResponse(response.status, _decode_response(response))
    except OSError, UnicodeError, http.client.HTTPException:
        # Exception text, bearer and bodies may contain internals. Never copy them into logs or JSON.
        log.warning("team request failed (%s)", method)
        return TeamResponse(502, {"detail": "team unavailable"})
    finally:
        try:
            connection.close()
        except OSError:
            log.warning("team connection close failed (%s)", method)

    log.info("team %s %s -> HTTP %s", method, path, result.status)
    return result


def _decode_asset(response: http.client.HTTPResponse) -> TeamAssetResponse:
    if response.status != HTTPStatus.OK:
        return TeamAssetResponse(response.status, None, _decode_response(response))
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    raw_length = response.getheader("Content-Length")
    if content_type != "image/png" or raw_length is None:
        raise OSError("invalid Team asset response")
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise OSError("invalid Team asset response") from exc
    if not 1 <= length <= MAX_ASSISTANT_ICON_BYTES:
        raise OSError("invalid Team asset response")
    contents = response.read(MAX_ASSISTANT_ICON_BYTES + 1)
    if len(contents) != length:
        raise OSError("invalid Team asset response")
    return TeamAssetResponse(HTTPStatus.OK, contents, {})


def _request_asset(method: str, path: str) -> TeamAssetResponse:
    try:
        host, port = _endpoint()
        headers = _request_headers(
            method,
            path,
            None,
            accept="image/png",
            content_type=None,
            filename=None,
            bindings=_RequestBindings(),
        )
        connection = http.client.HTTPConnection(host, port, timeout=CONTROL_TIMEOUT_SECONDS)
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("Team asset request failed (%s)", method)
        return TeamAssetResponse(HTTPStatus.BAD_GATEWAY, None, {"detail": "team unavailable"})
    try:
        connection.request(method, path, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid Team status")
        result = _decode_asset(response)
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("Team asset request failed (%s)", method)
        return TeamAssetResponse(HTTPStatus.BAD_GATEWAY, None, {"detail": "team unavailable"})
    finally:
        with contextlib.suppress(OSError):
            connection.close()
    log.info("Team asset %s %s -> HTTP %s", method, path, result.status)
    return result


def _decode_stream(
    response: http.client.HTTPResponse,
    progress: ProgressSink,
) -> TeamResponse:
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if (
        response.status != HTTPStatus.OK
        or content_type != "application/x-ndjson"
        or response.getheader("Content-Length") is not None
        or response.getheader("Transfer-Encoding") != "chunked"
    ):
        raise OSError("invalid Team chat stream")
    sequence = 0
    event_count = 0
    byte_count = 0
    while True:
        raw = response.readline(progress_contract.MAX_LINE_BYTES + 1)
        if not raw:
            raise OSError("truncated Team chat stream")
        byte_count += len(raw)
        if byte_count > progress_contract.MAX_STREAM_BYTES:
            raise OSError("Team chat stream exceeded its limit")
        record = progress_contract.decode_line(raw)
        if record["type"] == "terminal":
            if response.read(1):
                raise OSError("Team chat stream continued after terminal")
            return TeamResponse(record["status"], record["body"])
        event_count += 1
        if event_count > progress_contract.MAX_EVENTS or record["seq"] != sequence + 1:
            raise OSError("invalid Team chat progress order")
        sequence = record["seq"]
        event = {key: value for key, value in record.items() if key != "type"}
        with contextlib.suppress(Exception):
            progress(event)


def _stream_request(
    method: str,
    path: str,
    body: bytes,
    *,
    timeout: int,
    bindings: _RequestBindings,
    progress: ProgressSink,
) -> TeamResponse:
    try:
        host, port = _endpoint()
        headers = _request_headers(
            method,
            path,
            body,
            accept="application/x-ndjson",
            content_type="application/json",
            filename=None,
            bindings=bindings,
        )
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("team chat stream failed (%s)", method)
        return TeamResponse(502, {"detail": "team unavailable"})
    try:
        connection.request(method, path, body=body, headers=headers)
        result = _decode_stream(connection.getresponse(), progress)
    except (
        OSError,
        UnicodeError,
        http.client.HTTPException,
        progress_contract.ProgressContractError,
    ):
        log.warning("team chat stream failed (%s)", method)
        return TeamResponse(502, {"detail": "team unavailable"})
    finally:
        with contextlib.suppress(OSError):
            connection.close()
    log.info("team %s %s -> HTTP %s", method, path, result.status)
    return result


def _call(
    method: str,
    path: str,
    payload: object | None = None,
    *,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
    max_body_bytes: int = MAX_JSON_BODY_BYTES,
    model_credential: tuple[str, str] | None = None,
) -> TeamResponse:
    body = _encode_payload(payload, max_bytes=max_body_bytes)
    return _request(
        method,
        path,
        body,
        content_type="application/json" if body is not None else None,
        filename=None,
        timeout=timeout,
        model_credential=model_credential,
    )


def _call_asset(path: str) -> TeamAssetResponse:
    return _request_asset("GET", path)


def _call_stream(
    method: str,
    path: str,
    payload: object,
    *,
    timeout: int,
    max_body_bytes: int = MAX_JSON_BODY_BYTES,
    bindings: _RequestBindings,
    progress: ProgressSink,
) -> TeamResponse:
    body = _encode_payload(payload, max_bytes=max_body_bytes)
    if body is None:
        raise TeamRequestError("stream request body is required")
    return _stream_request(
        method,
        path,
        body,
        timeout=timeout,
        bindings=bindings,
        progress=progress,
    )


def _call_raw(
    method: str,
    path: str,
    body: bytes,
    *,
    filename: str,
    media_type: str,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
) -> TeamResponse:
    if not isinstance(body, bytes) or not isinstance(filename, str) or not isinstance(media_type, str):
        raise TeamRequestError("raw file request is invalid")
    return _request(
        method,
        path,
        body,
        content_type=media_type,
        filename=filename,
        timeout=timeout,
    )
