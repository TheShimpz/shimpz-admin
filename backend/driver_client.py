"""Bounded authenticated HTTP transport from Admin to team-driver."""

from __future__ import annotations

import http.client
import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlparse

import modelproviders

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_TEAMDRIVER_URL", "http://team-driver:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_TEAMDRIVER_TOKEN_FILE", "/run/shimpz-teamdriver/token")

MAX_JSON_BODY_BYTES = 16 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
CONTROL_TIMEOUT_SECONDS = 180
FILE_NAME_HEADER = "X-Shimpz-Filename"


class TeamRequestError(ValueError):
    """The browser supplied an invalid id or request body; no driver call was made."""


@dataclass(frozen=True)
class DriverResponse:
    status: int
    body: dict[str, object]


@dataclass(frozen=True)
class _TokenCache:
    path: Path
    identity: tuple[int, int, int, int]
    token: str


_token_cache_lock = threading.Lock()
_token_cache: _TokenCache | None = None


def _token_identity(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def _read_token_file(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _driver_token() -> str:
    global _token_cache
    path = Path(TOKEN_FILE)
    identity = _token_identity(path)
    with _token_cache_lock:
        if _token_cache is not None and (_token_cache.path, _token_cache.identity) == (path, identity):
            return _token_cache.token
        token = _read_token_file(path)
        if not token:
            raise OSError("empty team-driver bearer")
        if _token_identity(path) != identity:
            raise OSError("team-driver bearer changed while reading")
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
        raise OSError("invalid team-driver endpoint") from exc
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
        raise OSError("invalid team-driver endpoint")
    try:
        return parsed.hostname, parsed.port or 7077
    except ValueError as exc:
        raise OSError("invalid team-driver endpoint") from exc


def _decode_response(response: http.client.HTTPResponse) -> dict[str, object]:
    if response.status == 204:
        raw_length = response.getheader("Content-Length")
        if raw_length not in {None, "0"} or response.read(1):
            raise OSError("invalid team-driver response")
        return {}

    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise OSError("invalid team-driver response")

    raw_length = response.getheader("Content-Length")
    if raw_length is not None:
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise OSError("invalid team-driver response") from exc
        if length < 0 or length > MAX_JSON_RESPONSE_BYTES:
            raise OSError("invalid team-driver response")

    raw = response.read(MAX_JSON_RESPONSE_BYTES + 1)
    if len(raw) > MAX_JSON_RESPONSE_BYTES:
        raise OSError("invalid team-driver response")
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid team-driver response") from exc
    if not isinstance(body, dict):
        raise OSError("invalid team-driver response")
    return body


def _request(
    method: str,
    path: str,
    body: bytes | None,
    *,
    content_type: str | None,
    filename: str | None,
    timeout: int,
    model_credential: tuple[str, str] | None = None,
) -> DriverResponse:
    connection = None
    try:
        host, port = _endpoint()
        token = _driver_token()
        headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        if content_type is not None:
            headers["Content-Type"] = content_type
        if filename is not None:
            headers[FILE_NAME_HEADER] = quote(filename, safe="")
        if model_credential is not None:
            provider, api_key = model_credential
            encoded_key = api_key.encode("ascii") if isinstance(api_key, str) and api_key.isascii() else b""
            if (
                provider not in modelproviders.PROVIDERS
                or not 16 <= len(encoded_key) <= 8 * 1024
                or any(not 33 <= byte <= 126 for byte in encoded_key)
            ):
                raise OSError("invalid private model credential")
            # Private Admin -> local controller hand-off. These headers never come from browser
            # input, never enter a Team payload, and are never included in this module's logs.
            headers["X-Shimpz-Model-Provider"] = provider
            headers["X-Shimpz-Model-Api-Key"] = api_key
        # Deliberately request-scoped: Admin calls can run concurrently, while a shared HTTP/1.1
        # socket would require serialization and could retain an authenticated connection across
        # bearer rotation. The local bridge avoids a TLS handshake, so isolation wins over pooling.
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid team-driver status")
        result = DriverResponse(response.status, _decode_response(response))
    except OSError, UnicodeError, http.client.HTTPException:
        # Exception text, bearer and bodies may contain internals. Never copy them into logs or JSON.
        log.warning("team-driver request failed (%s)", method)
        return DriverResponse(502, {"detail": "team-driver unavailable"})
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                log.warning("team-driver connection close failed (%s)", method)

    log.info("team-driver %s %s -> HTTP %s", method, path, result.status)
    return result


def _call(
    method: str,
    path: str,
    payload: object | None = None,
    *,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
    max_body_bytes: int = MAX_JSON_BODY_BYTES,
    model_credential: tuple[str, str] | None = None,
) -> DriverResponse:
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


def _call_raw(
    method: str,
    path: str,
    body: bytes,
    *,
    filename: str,
    media_type: str,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
) -> DriverResponse:
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
