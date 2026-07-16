"""Bounded Admin -> capsule-driver bridge for Capsules and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
capsule-driver owns runtime lifecycle and admission; this module reaches only its fixed internal
HTTP routes with the existing bearer file.  Driver JSON and HTTP status codes are preserved so a
safe 400/404/409 is not flattened into an ambiguous gateway error.
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

MAX_JSON_BODY_BYTES = 16 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
CONTROL_TIMEOUT_SECONDS = 180
OPERATION_TIMEOUT_SECONDS = 30

_CAPSULE_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_ASSISTANT_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_OPERATION_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_ALLOWED_OPERATIONS = frozenset({"hello"})


class CapsuleRequestError(ValueError):
    """The browser supplied an invalid id or request body; no driver call was made."""


@dataclass(frozen=True)
class DriverResponse:
    status: int
    body: dict[str, object]


def to_cid(name: object) -> str:
    """A Capsule name -> the Docker/Postgres-safe id used by capsule-driver."""
    return re.sub(r"[^a-z0-9_]+", "_", str(name).lower()).strip("_")[:40]


def _canonical_id(value: object, *, field: str, pattern: re.Pattern[str], maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not pattern.fullmatch(value):
        raise CapsuleRequestError(f"{field} must be a canonical lowercase identifier")
    return value


def canonical_capsule_id(value: object) -> str:
    return _canonical_id(value, field="capsule id", pattern=_CAPSULE_ID_RE, maximum=40)


def canonical_assistant_id(value: object) -> str:
    return _canonical_id(value, field="assistant id", pattern=_ASSISTANT_ID_RE, maximum=80)


def canonical_operation_id(value: object) -> str:
    operation = _canonical_id(value, field="operation id", pattern=_OPERATION_ID_RE, maximum=80)
    if operation not in _ALLOWED_OPERATIONS:
        raise CapsuleRequestError("only the declared hello operation is available")
    return operation


def _encode_payload(payload: object | None) -> bytes | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise CapsuleRequestError("request body must be a JSON object")
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise CapsuleRequestError("request body must be valid JSON") from exc
    if len(body) > MAX_JSON_BODY_BYTES:
        raise CapsuleRequestError(f"request body exceeds {MAX_JSON_BODY_BYTES} bytes")
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


def _call(
    method: str,
    path: str,
    payload: object | None = None,
    *,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
) -> DriverResponse:
    body = _encode_payload(payload)
    connection = None
    try:
        host, port = _endpoint()
        token = Path(TOKEN_FILE).read_text(encoding="utf-8").strip()
        if not token:
            raise OSError("empty capsule-driver bearer")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid capsule-driver status")
        result = DriverResponse(response.status, _decode_response(response))
    except OSError, UnicodeError, http.client.HTTPException:
        # Exception text, bearer and bodies may contain internals. Never copy them into logs or JSON.
        log.warning("capsule-driver request failed (%s)", method)
        return DriverResponse(502, {"detail": "capsule-driver unavailable"})
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                log.warning("capsule-driver connection close failed (%s)", method)

    log.info("capsule-driver %s %s -> HTTP %s", method, path, result.status)
    return result


def list_capsules() -> DriverResponse:
    return _call("GET", "/v1/capsules")


def create(capsule_id: object, name: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise CapsuleRequestError("capsule name must be between 1 and 80 characters")
    return _call("POST", f"/v1/capsules/{cid}/create", {"name": name.strip()})


def destroy(capsule_id: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    return _call("DELETE", f"/v1/capsules/{cid}")


def list_assistants() -> DriverResponse:
    """Return the capsule-driver's trusted, admission-controlled catalog."""
    return _call("GET", "/v1/assistants")


def _assistant_path(capsule_id: object, assistant_id: object | None = None) -> str:
    cid = canonical_capsule_id(capsule_id)
    base = f"/v1/capsules/{cid}/assistants"
    return base if assistant_id is None else f"{base}/{canonical_assistant_id(assistant_id)}"


def list_installed_assistants(capsule_id: object) -> DriverResponse:
    return _call("GET", _assistant_path(capsule_id))


def install_assistant(capsule_id: object, payload: object) -> DriverResponse:
    if not isinstance(payload, dict) or set(payload) != {"assistant"}:
        raise CapsuleRequestError("request body must contain only assistant")
    assistant_id = canonical_assistant_id(payload["assistant"])
    return _call("POST", _assistant_path(capsule_id), {"assistant": assistant_id})


def invoke_assistant_operation(
    capsule_id: object,
    assistant_id: object,
    operation_id: object,
    payload: object,
) -> DriverResponse:
    operation = canonical_operation_id(operation_id)
    if not isinstance(payload, dict) or set(payload) - {"name"}:
        raise CapsuleRequestError("hello input must be an object containing only name")
    name = payload.get("name", "Shimpz")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or "\n" in name or "\r" in name:
        raise CapsuleRequestError("name must be a non-empty single-line string up to 80 characters")
    path = f"{_assistant_path(capsule_id, assistant_id)}/operations/{operation}"
    return _call("POST", path, {"name": name.strip()}, timeout=OPERATION_TIMEOUT_SECONDS)


def uninstall_assistant(capsule_id: object, assistant_id: object) -> DriverResponse:
    return _call("DELETE", _assistant_path(capsule_id, assistant_id))
