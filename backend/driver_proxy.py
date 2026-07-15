"""Narrow, stateless Admin -> capsule-driver proxy for per-Capsule Driver credentials.

The Admin is only the authenticated UI boundary. It must never persist Driver credentials, merge
them into the Space ``.env``, or handle the Driver keyset. The capsule-driver owns that control
plane; this client forwards one bounded JSON request over its existing private bearer-authenticated
hop and returns one bounded JSON object.

Security invariants:

* resource ids are already canonical when accepted (no lossy path rewriting);
* only the five fixed Driver-credential operations below can be called;
* request and response bodies are bounded JSON objects;
* neither bodies, tokens, nor exception text are logged.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_CAPSULEDRIVER_URL", "http://capsule-driver:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_CAPSULEDRIVER_TOKEN_FILE", "/run/shimpz-capsuledriver/token")

MAX_JSON_BODY_BYTES = 64 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
TIMEOUT_SECONDS = 30

_CAPSULE_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_DRIVER_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
# Opaque, server-generated ids: lowercase path-safe bytes only; the Admin assigns no semantics.
_CREDENTIAL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class ProxyRequestError(ValueError):
    """The caller supplied a non-canonical id or invalid/oversized JSON payload."""


@dataclass(frozen=True)
class ProxyResponse:
    status: int
    body: dict[str, object]


def _canonical_id(value: object, *, field: str, pattern: re.Pattern[str], maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not pattern.fullmatch(value):
        raise ProxyRequestError(f"{field} must be a canonical lowercase identifier")
    return value


def canonical_capsule_id(value: object) -> str:
    return _canonical_id(value, field="capsule id", pattern=_CAPSULE_ID_RE, maximum=40)


def canonical_driver_id(value: object) -> str:
    return _canonical_id(value, field="driver id", pattern=_DRIVER_ID_RE, maximum=80)


def canonical_credential_id(value: object) -> str:
    return _canonical_id(value, field="credential id", pattern=_CREDENTIAL_ID_RE, maximum=64)


def _encode_payload(payload: object | None) -> bytes | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise ProxyRequestError("request body must be a JSON object")
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise ProxyRequestError("request body must be valid JSON") from exc
    if len(body) > MAX_JSON_BODY_BYTES:
        raise ProxyRequestError(f"request body exceeds {MAX_JSON_BODY_BYTES} bytes")
    return body


def _endpoint() -> tuple[str, int]:
    try:
        parsed = urlparse(URL)
    except ValueError as exc:
        raise OSError("invalid capsule-driver endpoint") from exc
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
        raise OSError("invalid capsule-driver endpoint")
    try:
        return parsed.hostname, parsed.port or 7077
    except ValueError as exc:
        raise OSError("invalid capsule-driver endpoint") from exc


def _decode_response(response: http.client.HTTPResponse) -> dict[str, object]:
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise OSError("invalid capsule-driver response")

    raw_length = response.getheader("Content-Length")
    if raw_length is not None:
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise OSError("invalid capsule-driver response") from exc
        if length < 0 or length > MAX_JSON_RESPONSE_BYTES:
            raise OSError("invalid capsule-driver response")

    raw = response.read(MAX_JSON_RESPONSE_BYTES + 1)
    if len(raw) > MAX_JSON_RESPONSE_BYTES:
        raise OSError("invalid capsule-driver response")
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid capsule-driver response") from exc
    if not isinstance(body, dict):
        raise OSError("invalid capsule-driver response")
    return body


def _call(method: str, path: str, *, payload: object | None = None) -> ProxyResponse:
    body = _encode_payload(payload)
    connection = None
    try:
        host, port = _endpoint()
        token = Path(TOKEN_FILE).read_text(encoding="utf-8").strip()
        if not token:
            raise OSError("empty capsule-driver bearer")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"

        connection = http.client.HTTPConnection(host, port, timeout=TIMEOUT_SECONDS)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = ProxyResponse(response.status, _decode_response(response))
    except OSError, UnicodeError, http.client.HTTPException:
        # Deliberately omit exception text: it can include endpoint internals. Bodies and the bearer
        # are never passed to logging at all.
        log.warning("capsule-driver credential proxy request failed (%s)", method)
        return ProxyResponse(502, {"detail": "capsule-driver unavailable"})
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                log.warning("capsule-driver credential proxy close failed (%s)", method)

    log.info("capsule-driver credential proxy %s -> HTTP %s", method, result.status)
    return result


def _driver_path(capsule_id: object, driver_id: object) -> str:
    cid = canonical_capsule_id(capsule_id)
    did = canonical_driver_id(driver_id)
    return f"/v1/capsules/{cid}/drivers/{did}"


def _credential_path(capsule_id: object, driver_id: object, credential_id: object) -> str:
    base = _driver_path(capsule_id, driver_id)
    crid = canonical_credential_id(credential_id)
    return f"{base}/credentials/{crid}"


def get_driver(capsule_id: object, driver_id: object) -> ProxyResponse:
    return _call("GET", _driver_path(capsule_id, driver_id))


def create_credential(capsule_id: object, driver_id: object, payload: object) -> ProxyResponse:
    return _call("POST", f"{_driver_path(capsule_id, driver_id)}/credentials", payload=payload)


def replace_credential(capsule_id: object, driver_id: object, credential_id: object, payload: object) -> ProxyResponse:
    return _call("PUT", _credential_path(capsule_id, driver_id, credential_id), payload=payload)


def delete_credential(
    capsule_id: object, driver_id: object, credential_id: object, payload: object | None = None
) -> ProxyResponse:
    return _call("DELETE", _credential_path(capsule_id, driver_id, credential_id), payload=payload)


def verify_credential(capsule_id: object, driver_id: object, credential_id: object, payload: object) -> ProxyResponse:
    path = f"{_credential_path(capsule_id, driver_id, credential_id)}/verify"
    return _call("POST", path, payload=payload)
