"""Bounded Admin -> capsule-driver bridge for Capsules and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
capsule-driver owns runtime lifecycle and admission; this module reaches only its fixed internal
HTTP routes with the existing bearer file.  Driver JSON and HTTP status codes are preserved so a
safe 400/404/409 is not flattened into an ambiguous gateway error.
"""

from __future__ import annotations

import base64
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
MAX_CHAT_JSON_BODY_BYTES = 24 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_FILE_JSON_BODY_BYTES = 4 * ((MAX_FILE_UPLOAD_BYTES + 2) // 3) + 8192
CONTROL_TIMEOUT_SECONDS = 180

_CAPSULE_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_ASSISTANT_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_FILE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MEDIA_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+\-]*/[a-z0-9][a-z0-9!#$&^_.+\-]*$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_MODEL_PROVIDERS = frozenset({"anthropic", "openai"})
MAX_CHAT_MESSAGE_CHARS = 16_000
MAX_CHAT_FILES = 8


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


def canonical_filename(value: object) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise CapsuleRequestError("filename must be non-empty and trimmed")
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as exc:
        raise CapsuleRequestError("filename must be valid UTF-8") from exc
    if len(encoded) > 255:
        raise CapsuleRequestError("filename is too long")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise CapsuleRequestError("filename must not contain a path")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise CapsuleRequestError("filename contains control characters")
    return value


def canonical_media_type(value: object) -> str:
    if value is None or value == "":
        return "application/octet-stream"
    if not isinstance(value, str) or len(value) > 127:
        raise CapsuleRequestError("invalid media type")
    media_type = value.lower()
    if _MEDIA_TYPE_RE.fullmatch(media_type) is None:
        raise CapsuleRequestError("invalid media type")
    return media_type


def _encode_payload(payload: object | None, *, max_bytes: int = MAX_JSON_BODY_BYTES) -> bytes | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise CapsuleRequestError("request body must be a JSON object")
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise CapsuleRequestError("request body must be valid JSON") from exc
    if len(body) > max_bytes:
        raise CapsuleRequestError(f"request body exceeds {max_bytes} bytes")
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
    max_body_bytes: int = MAX_JSON_BODY_BYTES,
    model_credential: tuple[str, str] | None = None,
) -> DriverResponse:
    body = _encode_payload(payload, max_bytes=max_body_bytes)
    connection = None
    try:
        host, port = _endpoint()
        token = Path(TOKEN_FILE).read_text(encoding="utf-8").strip()
        if not token:
            raise OSError("empty capsule-driver bearer")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if model_credential is not None:
            provider, api_key = model_credential
            encoded_key = api_key.encode("ascii") if isinstance(api_key, str) and api_key.isascii() else b""
            if (
                provider not in _MODEL_PROVIDERS
                or not 16 <= len(encoded_key) <= 8 * 1024
                or any(not 33 <= byte <= 126 for byte in encoded_key)
            ):
                raise OSError("invalid private model credential")
            # Private Admin -> local controller hand-off. These headers never come from browser
            # input, never enter a Capsule payload, and are never included in this module's logs.
            headers["X-Shimpz-Model-Provider"] = provider
            headers["X-Shimpz-Model-Api-Key"] = api_key
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
        raise CapsuleRequestError("team name must be between 1 and 80 characters")
    return _call("POST", f"/v1/capsules/{cid}/create", {"name": name.strip()})


def destroy(capsule_id: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    return _call("DELETE", f"/v1/capsules/{cid}")


def get_inference(capsule_id: object) -> DriverResponse:
    """Read provider/model metadata only; the controller response must never contain a key."""
    cid = canonical_capsule_id(capsule_id)
    return _call("GET", f"/v1/capsules/{cid}/inference")


def configure_inference(capsule_id: object, payload: object) -> DriverResponse:
    """Forward the closed, secret-free Capsule inference contract."""
    cid = canonical_capsule_id(capsule_id)
    if not isinstance(payload, dict) or set(payload) != {"provider", "model"}:
        raise CapsuleRequestError("inference requires only provider and model")
    provider = payload["provider"]
    model = payload["model"]
    if not isinstance(provider, str) or provider not in _MODEL_PROVIDERS:
        raise CapsuleRequestError("unsupported model provider")
    if not isinstance(model, str) or _MODEL_RE.fullmatch(model) is None:
        raise CapsuleRequestError("model must be a safe identifier of at most 128 characters")
    return _call("PUT", f"/v1/capsules/{cid}/inference", {"provider": provider, "model": model})


def canonical_chat_payload(payload: object) -> dict[str, object]:
    """Validate the Team chat contract without exposing its internal Assistants."""
    if not isinstance(payload, dict) or set(payload) not in ({"message"}, {"message", "files"}):
        raise CapsuleRequestError("chat requires message and optional files")
    message = payload["message"]
    if not isinstance(message, str) or not (message := message.strip()):
        raise CapsuleRequestError("message must be non-empty")
    if len(message) > MAX_CHAT_MESSAGE_CHARS:
        raise CapsuleRequestError(f"message exceeds {MAX_CHAT_MESSAGE_CHARS} characters")
    files = payload.get("files", [])
    if not isinstance(files, list) or len(files) > MAX_CHAT_FILES:
        raise CapsuleRequestError(f"files must contain at most {MAX_CHAT_FILES} ids")
    canonical_files = [_canonical_id(item, field="file id", pattern=_FILE_ID_RE, maximum=32) for item in files]
    if len(set(canonical_files)) != len(canonical_files):
        raise CapsuleRequestError("files must not contain duplicate ids")
    return {"message": message, "files": canonical_files}


def chat(
    capsule_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    """Send a turn whose JSON is secret-free; the key uses the private authenticated header."""
    cid = canonical_capsule_id(capsule_id)
    body = canonical_chat_payload(payload)
    return _call(
        "POST",
        f"/v1/capsules/{cid}/chat",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
        model_credential=(provider, api_key),
    )


def stop_chat(capsule_id: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    return _call("POST", f"/v1/capsules/{cid}/chat/stop", {})


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


def uninstall_assistant(capsule_id: object, assistant_id: object) -> DriverResponse:
    return _call("DELETE", _assistant_path(capsule_id, assistant_id))


def _files_path(capsule_id: object, file_id: object | None = None) -> str:
    cid = canonical_capsule_id(capsule_id)
    base = f"/v1/capsules/{cid}/files"
    if file_id is None:
        return base
    return f"{base}/{_canonical_id(file_id, field='file id', pattern=_FILE_ID_RE, maximum=32)}"


def _integer(value: object, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError("invalid integer")
    return value


def _usage(document: dict[str, object]) -> dict[str, int]:
    used = _integer(document.get("used_bytes"))
    limit = _integer(document.get("limit_bytes"), minimum=1)
    remaining = _integer(document.get("remaining_bytes"))
    if used > limit or remaining != limit - used:
        raise ValueError("invalid storage usage")
    return {"used_bytes": used, "limit_bytes": limit, "remaining_bytes": remaining}


def _file_metadata(document: object, *, include_usage: bool) -> dict[str, object]:
    if not isinstance(document, dict):
        raise ValueError("invalid file metadata")
    file_id = document.get("id")
    sha256 = document.get("sha256")
    if not isinstance(file_id, str) or _FILE_ID_RE.fullmatch(file_id) is None:
        raise ValueError("invalid file id")
    if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256) is None:
        raise ValueError("invalid file digest")
    metadata: dict[str, object] = {
        "id": file_id,
        "name": canonical_filename(document.get("name")),
        "media_type": canonical_media_type(document.get("media_type")),
        "size": _integer(document.get("size"), minimum=1),
        "sha256": sha256,
        "created_at": _integer(document.get("created_at"), minimum=1),
    }
    if metadata["size"] > MAX_FILE_UPLOAD_BYTES:
        raise ValueError("invalid file size")
    if include_usage:
        metadata.update(_usage(document))
    return metadata


def _project_storage_response(response: DriverResponse, *, capsule_id: str, kind: str) -> DriverResponse:
    if not 200 <= response.status < 300:
        error_body = {
            key: value
            for key in ("detail", "error", "code")
            if isinstance((value := response.body.get(key)), str) and 0 < len(value) <= 500
        }
        if not error_body:
            error_body = {"detail": "capsule-driver request failed"}
        return DriverResponse(response.status, error_body)
    try:
        if response.body.get("capsule") != capsule_id:
            raise ValueError("invalid Capsule identity")
        if kind == "upload":
            body: dict[str, object] = {
                "capsule": capsule_id,
                "file": _file_metadata(response.body.get("file"), include_usage=True),
            }
        elif kind == "list":
            files = response.body.get("files")
            if not isinstance(files, list) or len(files) > 256:
                raise ValueError("invalid file inventory")
            body = {
                "capsule": capsule_id,
                "files": [_file_metadata(item, include_usage=False) for item in files],
                **_usage(response.body),
            }
        elif kind == "delete":
            file_id = response.body.get("id")
            deleted = response.body.get("deleted")
            if not isinstance(file_id, str) or _FILE_ID_RE.fullmatch(file_id) is None:
                raise ValueError("invalid file id")
            if not isinstance(deleted, bool):
                raise ValueError("invalid deletion result")
            body = {"capsule": capsule_id, "id": file_id, "deleted": deleted, **_usage(response.body)}
        else:
            raise ValueError("invalid storage response kind")
    except CapsuleRequestError, TypeError, ValueError:
        log.warning("capsule-driver returned an invalid storage response (%s)", kind)
        return DriverResponse(502, {"detail": "capsule-driver unavailable"})
    return DriverResponse(response.status, body)


def upload_file(capsule_id: object, filename: object, media_type: object, content: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    safe_filename = canonical_filename(filename)
    safe_media_type = canonical_media_type(media_type)
    if not isinstance(content, bytes) or not content:
        raise CapsuleRequestError("file must contain bytes")
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        raise CapsuleRequestError(f"file exceeds {MAX_FILE_UPLOAD_BYTES} bytes")
    payload = {
        "filename": safe_filename,
        "media_type": safe_media_type,
        "content_b64": base64.b64encode(content).decode("ascii"),
    }
    response = _call("POST", _files_path(cid), payload, max_body_bytes=MAX_FILE_JSON_BODY_BYTES)
    return _project_storage_response(response, capsule_id=cid, kind="upload")


def list_files(capsule_id: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    response = _call("GET", _files_path(cid))
    return _project_storage_response(response, capsule_id=cid, kind="list")


def delete_file(capsule_id: object, file_id: object) -> DriverResponse:
    cid = canonical_capsule_id(capsule_id)
    response = _call("DELETE", _files_path(cid, file_id))
    return _project_storage_response(response, capsule_id=cid, kind="delete")
