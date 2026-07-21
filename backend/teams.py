"""Bounded Admin -> team-driver bridge for Teams and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
team-driver owns runtime lifecycle and admission; this module reaches only its fixed internal
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
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

import modelproviders

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_TEAMDRIVER_URL", "http://team-driver:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_TEAMDRIVER_TOKEN_FILE", "/run/shimpz-teamdriver/token")

MAX_JSON_BODY_BYTES = 16 * 1024
MAX_CHAT_JSON_BODY_BYTES = 24 * 1024
MAX_SECRET_JSON_BODY_BYTES = 512 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_FILE_JSON_BODY_BYTES = 4 * ((MAX_FILE_UPLOAD_BYTES + 2) // 3) + 8192
CONTROL_TIMEOUT_SECONDS = 180

_TEAM_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_ASSISTANT_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
ASSISTANT_HELP_LOCALES = frozenset({"en", "pt", "es", "zh", "fr", "de", "ja", "ar"})
_FILE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MEDIA_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+\-]*/[a-z0-9][a-z0-9!#$&^_.+\-]*$")
MAX_CHAT_MESSAGE_CHARS = 16_000
MAX_CHAT_FILES = 8
MAX_CHAT_ASSISTANTS = 16
MAX_SECRET_SUBMISSIONS = 64
MAX_ASSISTANT_SECRET_BYTES = 16 * 1024
MAX_TEAMS = 128
MAX_TEAM_NAME_CHARS = 80
MAX_ASSISTANT_ACCOUNTS = 512
MAX_ACCOUNT_SCOPES = 32

_OAUTH_BINDING_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_OAUTH_CLAIM_RE = re.compile(r"^[0-9a-f]{64}$")
_OAUTH_SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
_CLOUDFLARE_SCOPES = ("dns.read", "offline_access", "zone.read")


class TeamRequestError(ValueError):
    """The browser supplied an invalid id or request body; no driver call was made."""


@dataclass(frozen=True)
class DriverResponse:
    status: int
    body: dict[str, object]


def to_team_id(team_name: object) -> str:
    """A Team name -> the Docker/Postgres-safe id used by team-driver."""
    return re.sub(r"[^a-z0-9_]+", "_", str(team_name).lower()).strip("_")[:40]


def _canonical_id(value: object, *, field: str, pattern: re.Pattern[str], maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not pattern.fullmatch(value):
        raise TeamRequestError(f"{field} must be a canonical lowercase identifier")
    return value


def canonical_team_id(value: object) -> str:
    return _canonical_id(value, field="team id", pattern=_TEAM_ID_RE, maximum=40)


def canonical_team_name(value: object) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= MAX_TEAM_NAME_CHARS
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise TeamRequestError("team name must contain 1 to 80 trimmed characters")
    return value


def canonical_assistant_id(value: object) -> str:
    return _canonical_id(value, field="assistant id", pattern=_ASSISTANT_ID_RE, maximum=80)


def canonical_assistant_help_locale(value: object) -> str:
    if not isinstance(value, str) or value not in ASSISTANT_HELP_LOCALES:
        raise TeamRequestError("unsupported Assistant Help locale")
    return value


def canonical_oauth_binding(value: object) -> str:
    if not isinstance(value, str) or _OAUTH_BINDING_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth browser binding is invalid")
    return value


def canonical_challenge_id(value: object) -> str:
    if not isinstance(value, str) or _CHALLENGE_ID_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth challenge is invalid")
    return value


def canonical_oauth_claim(value: object) -> str:
    if not isinstance(value, str) or _OAUTH_CLAIM_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth authorization response is invalid")
    return value


def canonical_filename(value: object) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise TeamRequestError("filename must be non-empty and trimmed")
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as exc:
        raise TeamRequestError("filename must be valid UTF-8") from exc
    if len(encoded) > 255:
        raise TeamRequestError("filename is too long")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise TeamRequestError("filename must not contain a path")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise TeamRequestError("filename contains control characters")
    return value


def canonical_media_type(value: object) -> str:
    if value is None or value == "":
        return "application/octet-stream"
    if not isinstance(value, str) or len(value) > 127:
        raise TeamRequestError("invalid media type")
    media_type = value.lower()
    if _MEDIA_TYPE_RE.fullmatch(media_type) is None:
        raise TeamRequestError("invalid media type")
    return media_type


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
            raise OSError("empty team-driver bearer")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
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


def list_teams() -> DriverResponse:
    return _call("GET", "/v1/teams")


def create(team_id: object, team_name: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    if not isinstance(team_name, str) or not team_name.strip() or len(team_name) > MAX_TEAM_NAME_CHARS:
        raise TeamRequestError("team name must be between 1 and 80 characters")
    return _call("POST", f"/v1/teams/{canonical_id}/create", {"team_name": team_name.strip()})


def _authoritative_team_name(response: DriverResponse, team_id: str) -> DriverResponse | str:
    """Project one strict Team identity from the controller inventory before destruction."""
    if not 200 <= response.status < 300:
        return response
    try:
        allowed_envelope = {"teams"}
        if "trace_id" in response.body:
            allowed_envelope.add("trace_id")
            trace_id = response.body["trace_id"]
            if not isinstance(trace_id, str) or _TRACE_ID_RE.fullmatch(trace_id) is None:
                raise ValueError("invalid trace id")
        if set(response.body) != allowed_envelope:
            raise ValueError("unexpected inventory fields")
        inventory = response.body["teams"]
        if not isinstance(inventory, list) or len(inventory) > MAX_TEAMS:
            raise ValueError("invalid inventory")
        names: dict[str, str] = {}
        for item in inventory:
            if not isinstance(item, dict) or set(item) != {"team_id", "team_name", "status"}:
                raise ValueError("invalid Team fields")
            item_id = canonical_team_id(item["team_id"])
            item_name = canonical_team_name(item["team_name"])
            if item["team_id"] != item_id or item["team_name"] != item_name or item["status"] != "running":
                raise ValueError("non-canonical Team identity")
            if item_id in names:
                raise ValueError("duplicate Team identity")
            names[item_id] = item_name
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team-driver returned an invalid Team inventory")
        return DriverResponse(502, {"detail": "Team inventory response is invalid."})
    try:
        return names[team_id]
    except KeyError:
        return DriverResponse(404, {"detail": "Team not found"})


def destroy(team_id: object, expected_team_name: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    expected_name = canonical_team_name(expected_team_name)
    authoritative = _authoritative_team_name(list_teams(), canonical_id)
    if isinstance(authoritative, DriverResponse):
        return authoritative
    if authoritative != expected_name:
        raise TeamRequestError("Team name confirmation does not match")
    return _call("DELETE", f"/v1/teams/{canonical_id}")


def _project_inference_response(
    response: DriverResponse,
    team_id: str,
    *,
    expected: tuple[str, str] | None = None,
) -> DriverResponse:
    """Project the authenticated controller envelope into the smaller browser contract."""
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"team_id", "provider", "model", "trace_id"}:
            raise ValueError("unexpected inference fields")
        response_team_id = response.body["team_id"]
        provider = response.body["provider"]
        model = response.body["model"]
        trace_id = response.body["trace_id"]
        selected_team_id = canonical_team_id(response_team_id)
        selected_provider = modelproviders.canonical_provider(provider)
        selected_model = modelproviders.canonical_model(selected_provider, model)
        if (
            response_team_id != selected_team_id
            or selected_team_id != team_id
            or provider != selected_provider
            or model != selected_model
            or not isinstance(trace_id, str)
            or _TRACE_ID_RE.fullmatch(trace_id) is None
        ):
            raise ValueError("non-canonical inference metadata")
        if expected is not None and (selected_provider, selected_model) != expected:
            raise ValueError("mismatched inference metadata")
    except KeyError, TypeError, ValueError, TeamRequestError, modelproviders.ModelProviderError:
        # Never reflect controller fields: an invalid response could contain credentials or internals.
        log.warning("team-driver returned an invalid inference response")
        return DriverResponse(502, {"detail": "Team inference response is invalid."})
    return DriverResponse(
        response.status,
        {"team_id": team_id, "provider": selected_provider, "model": selected_model},
    )


def get_inference(team_id: object) -> DriverResponse:
    """Read provider/model metadata only; the controller response must never contain a key."""
    canonical_id = canonical_team_id(team_id)
    response = _call("GET", f"/v1/teams/{canonical_id}/inference")
    return _project_inference_response(response, canonical_id)


def configure_inference(team_id: object, payload: object) -> DriverResponse:
    """Forward the closed, secret-free Team inference contract."""
    canonical_id = canonical_team_id(team_id)
    if not isinstance(payload, dict) or set(payload) != {"provider", "model"}:
        raise TeamRequestError("inference requires only provider and model")
    provider = payload["provider"]
    model = payload["model"]
    try:
        selected_provider = modelproviders.canonical_provider(provider)
        selected_model = modelproviders.canonical_model(selected_provider, model)
    except modelproviders.ModelProviderError as exc:
        raise TeamRequestError(str(exc)) from None
    if provider != selected_provider:
        raise TeamRequestError("model provider must be canonical")
    response = _call(
        "PUT",
        f"/v1/teams/{canonical_id}/inference",
        {"provider": selected_provider, "model": selected_model},
    )
    return _project_inference_response(
        response,
        canonical_id,
        expected=(selected_provider, selected_model),
    )


def canonical_chat_payload(payload: object) -> dict[str, object]:
    """Validate one explicit Assistant scope without treating an empty scope as all."""
    if not isinstance(payload, dict) or set(payload) != {"message", "files", "assistant_ids"}:
        raise TeamRequestError("chat requires message, files, and assistant_ids")
    message = payload["message"]
    if not isinstance(message, str) or not (message := message.strip()):
        raise TeamRequestError("message must be non-empty")
    if len(message) > MAX_CHAT_MESSAGE_CHARS:
        raise TeamRequestError(f"message exceeds {MAX_CHAT_MESSAGE_CHARS} characters")
    files = payload["files"]
    if not isinstance(files, list) or len(files) > MAX_CHAT_FILES:
        raise TeamRequestError(f"files must contain at most {MAX_CHAT_FILES} ids")
    canonical_files = [_canonical_id(item, field="file id", pattern=_FILE_ID_RE, maximum=32) for item in files]
    if len(set(canonical_files)) != len(canonical_files):
        raise TeamRequestError("files must not contain duplicate ids")
    assistant_ids = payload["assistant_ids"]
    if not isinstance(assistant_ids, list) or len(assistant_ids) > MAX_CHAT_ASSISTANTS:
        raise TeamRequestError(f"assistant_ids must contain at most {MAX_CHAT_ASSISTANTS} ids")
    canonical_assistant_ids = [canonical_assistant_id(item) for item in assistant_ids]
    if len(set(canonical_assistant_ids)) != len(canonical_assistant_ids):
        raise TeamRequestError("assistant_ids must not contain duplicate ids")
    return {
        "message": message,
        "files": canonical_files,
        "assistant_ids": canonical_assistant_ids,
    }


def canonical_secret_submission(payload: object) -> dict[str, object]:
    """Validate a one-use JIT submission without retaining or logging its values."""
    if not isinstance(payload, dict) or set(payload) != {"challenge_id", "values"}:
        raise TeamRequestError("secret submission requires challenge_id and values")
    challenge_id = payload["challenge_id"]
    values = payload["values"]
    if not isinstance(challenge_id, str) or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None:
        raise TeamRequestError("secret challenge is invalid")
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_SECRET_SUBMISSIONS:
        raise TeamRequestError("secret values exceed their fixed limit")
    canonical: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in values:
        if not isinstance(item, dict) or set(item) != {"assistant_id", "secret_id", "value"}:
            raise TeamRequestError("secret value has an invalid shape")
        assistant_id = canonical_assistant_id(item["assistant_id"])
        secret_id = canonical_assistant_id(item["secret_id"])
        value = item["value"]
        if not isinstance(value, str) or not value or value != value.strip() or not value.isprintable():
            raise TeamRequestError("secret value is invalid")
        try:
            encoded = value.encode("utf-8")
        except UnicodeError as exc:
            raise TeamRequestError("secret value is invalid") from exc
        if len(encoded) > MAX_ASSISTANT_SECRET_BYTES:
            raise TeamRequestError("secret value exceeds its fixed limit")
        identity = (assistant_id, secret_id)
        if identity in seen:
            raise TeamRequestError("secret values must not contain duplicates")
        seen.add(identity)
        canonical.append({"assistant_id": assistant_id, "secret_id": secret_id, "value": value})
    return {"challenge_id": challenge_id, "values": canonical}


def canonical_secret_replacement(payload: object) -> dict[str, object]:
    """Validate one atomic Assistant credential replacement without retaining its values."""
    if not isinstance(payload, dict) or set(payload) != {"assistant_id", "values"}:
        raise TeamRequestError("secret replacement requires assistant_id and values")
    assistant_id = canonical_assistant_id(payload["assistant_id"])
    values = payload["values"]
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_SECRET_SUBMISSIONS:
        raise TeamRequestError("secret values exceed their fixed limit")
    canonical: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, dict) or set(item) != {"secret_id", "value"}:
            raise TeamRequestError("secret value has an invalid shape")
        secret_id = canonical_assistant_id(item["secret_id"])
        value = item["value"]
        if not isinstance(value, str) or not value or value != value.strip() or not value.isprintable():
            raise TeamRequestError("secret value is invalid")
        try:
            encoded = value.encode("utf-8")
        except UnicodeError as exc:
            raise TeamRequestError("secret value is invalid") from exc
        if len(encoded) > MAX_ASSISTANT_SECRET_BYTES:
            raise TeamRequestError("secret value exceeds its fixed limit")
        if secret_id in seen:
            raise TeamRequestError("secret values must not contain duplicates")
        seen.add(secret_id)
        canonical.append({"secret_id": secret_id, "value": value})
    return {"assistant_id": assistant_id, "values": canonical}


def canonical_approval_submission(payload: object) -> dict[str, object]:
    """Accept only an explicit approval of one exact pending challenge."""
    if not isinstance(payload, dict) or set(payload) != {"challenge_id", "approved"}:
        raise TeamRequestError("approval submission requires challenge_id and approved")
    challenge_id = payload["challenge_id"]
    if not isinstance(challenge_id, str) or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None:
        raise TeamRequestError("approval challenge is invalid")
    if payload["approved"] is not True:
        raise TeamRequestError("approval must be explicit")
    return {"challenge_id": challenge_id, "approved": True}


def canonical_account_resume(payload: object) -> dict[str, str]:
    """Bind continuation to the one exact controller-owned account challenge."""
    if not isinstance(payload, dict) or set(payload) != {"challenge_id"}:
        raise TeamRequestError("account continuation requires only challenge_id")
    return {"challenge_id": canonical_challenge_id(payload["challenge_id"])}


def chat(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    """Send a turn whose JSON is secret-free; the key uses the private authenticated header."""
    canonical_id = canonical_team_id(team_id)
    body = canonical_chat_payload(payload)
    return _call(
        "POST",
        f"/v1/teams/{canonical_id}/chat",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
        model_credential=(provider, api_key),
    )


def stop_chat(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("POST", f"/v1/teams/{canonical_id}/chat/stop", {})


def pending_chat_secrets(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/chat/secrets")


def pending_chat_approval(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/chat/approval")


def pending_chat_accounts(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/chat/accounts")


def resume_chat_accounts(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_account_resume(payload)
    return _call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/accounts",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        model_credential=(provider, api_key),
    )


def submit_chat_secrets(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_secret_submission(payload)
    return _call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/secrets",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_SECRET_JSON_BODY_BYTES,
        model_credential=(provider, api_key),
    )


def submit_chat_approval(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_approval_submission(payload)
    return _call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/approval",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_SECRET_JSON_BODY_BYTES,
        model_credential=(provider, api_key),
    )


def list_assistant_secrets(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/assistant-secrets")


def replace_assistant_secrets(team_id: object, payload: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_secret_replacement(payload)
    return _call(
        "PUT",
        f"/v1/teams/{canonical_id}/assistant-secrets",
        body,
        max_body_bytes=MAX_SECRET_JSON_BODY_BYTES,
    )


def list_assistant_approvals(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/assistant-approvals")


def revoke_assistant_approvals(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("DELETE", f"/v1/teams/{canonical_id}/assistant-approvals")


def _public_text(value: object, *, field: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError(f"invalid {field}")
    return value


def _account_scopes(value: object) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ACCOUNT_SCOPES:
        raise ValueError("invalid OAuth scopes")
    scopes: list[str] = []
    for item in value:
        if not isinstance(item, str) or _OAUTH_SCOPE_RE.fullmatch(item) is None:
            raise ValueError("invalid OAuth scopes")
        scopes.append(item)
    if len(set(scopes)) != len(scopes):
        raise ValueError("duplicate OAuth scopes")
    return scopes


def _account_identity(value: object) -> dict[str, str | None] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"id", "name", "username"}:
        raise ValueError("invalid OAuth account")
    account_id = _public_text(value["id"], field="OAuth account id", maximum=128)
    result: dict[str, str | None] = {"id": account_id, "name": None, "username": None}
    for field in ("name", "username"):
        item = value[field]
        if item is not None:
            result[field] = _public_text(item, field=f"OAuth account {field}", maximum=128)
    return result


def _account_expiry(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 40 or _RFC3339_RE.fullmatch(value) is None:
        raise ValueError("invalid OAuth expiry")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("invalid OAuth expiry") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("invalid OAuth expiry")
    return value


def _project_account_inventory(response: DriverResponse, team_id: str) -> DriverResponse:
    """Expose status metadata only; provider tokens and controller generations stay private."""
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"team_id", "accounts"} or response.body["team_id"] != team_id:
            raise ValueError("invalid Team account envelope")
        raw_accounts = response.body["accounts"]
        if not isinstance(raw_accounts, list) or len(raw_accounts) > MAX_ASSISTANT_ACCOUNTS:
            raise ValueError("invalid Team account inventory")
        accounts: list[dict[str, object]] = []
        identities: set[tuple[str, str]] = set()
        for item in raw_accounts:
            if not isinstance(item, dict) or set(item) != {
                "assistant_id",
                "assistant_name",
                "id",
                "provider",
                "name",
                "summary",
                "scopes",
                "status",
                "account",
                "expires_at",
            }:
                raise ValueError("invalid Team account fields")
            assistant_id = canonical_assistant_id(item["assistant_id"])
            account_id = canonical_assistant_id(item["id"])
            identity = (assistant_id, account_id)
            if identity in identities:
                raise ValueError("duplicate Team account")
            identities.add(identity)
            status = item["status"]
            if status not in {"missing", "connected", "expired", "reauthorization-required"}:
                raise ValueError("invalid Team account status")
            accounts.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": _public_text(item["assistant_name"], field="Assistant name", maximum=80),
                    "id": account_id,
                    "provider": canonical_assistant_id(item["provider"]),
                    "name": _public_text(item["name"], field="account name", maximum=80),
                    "summary": _public_text(item["summary"], field="account summary", maximum=160),
                    "scopes": _account_scopes(item["scopes"]),
                    "status": status,
                    "account": _account_identity(item["account"]),
                    "expires_at": _account_expiry(item["expires_at"]),
                }
            )
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team-driver returned an invalid Assistant account inventory")
        return DriverResponse(502, {"detail": "Assistant account inventory is invalid."})
    return DriverResponse(200, {"accounts": accounts})


def list_assistant_accounts(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _project_account_inventory(
        _call("GET", f"/v1/teams/{canonical_id}/assistant-accounts"),
        canonical_id,
    )


def _trusted_cloudflare_authorization_url(value: object, callback_mode: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        raise ValueError("invalid OAuth authorization URL")
    try:
        parsed = urlparse(value)
        query = parse_qsl(
            parsed.query,
            keep_blank_values=True,
            strict_parsing=True,
            max_num_fields=4,
        )
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid OAuth authorization URL") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "shimpz.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/api/oauth/cloudflare/start"
        or parsed.params
        or parsed.fragment
        or len(query) != 4
        or len({key for key, _value in query}) != 4
    ):
        raise ValueError("invalid OAuth authorization URL")
    fields = dict(query)
    if set(fields) != {"scope", "state", "code_challenge", "callback"}:
        raise ValueError("invalid OAuth authorization URL")
    if (
        _OAUTH_BINDING_RE.fullmatch(fields["state"]) is None
        or _OAUTH_BINDING_RE.fullmatch(fields["code_challenge"]) is None
        or fields["callback"] != callback_mode
    ):
        raise ValueError("invalid OAuth authorization URL")
    scopes = fields["scope"].split(" ")
    if tuple(_account_scopes(scopes)) != _CLOUDFLARE_SCOPES:
        raise ValueError("invalid OAuth authorization URL")
    return value


def start_assistant_account_authorization(
    team_id: object,
    challenge_id: object,
    session_binding: object,
    callback_mode: object,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    challenge_id = canonical_challenge_id(challenge_id)
    binding = canonical_oauth_binding(session_binding)
    if callback_mode not in {"loopback", "canary"}:
        raise TeamRequestError("OAuth callback mode is invalid.")
    response = _call(
        "POST",
        f"/v1/teams/{canonical_id}/assistant-accounts/challenges/{challenge_id}/authorize",
        {"session_binding": binding},
    )
    if not 200 <= response.status < 300:
        return response
    try:
        if (
            set(response.body) != {"authorization_url", "trace_id"}
            or not isinstance(response.body["trace_id"], str)
            or _TRACE_ID_RE.fullmatch(response.body["trace_id"]) is None
        ):
            raise ValueError("invalid OAuth authorization response")
        authorization_url = _trusted_cloudflare_authorization_url(response.body["authorization_url"], callback_mode)
    except KeyError, TypeError, ValueError:
        log.warning("team-driver returned an invalid OAuth authorization response")
        return DriverResponse(502, {"detail": "OAuth authorization response is invalid."})
    return DriverResponse(200, {"authorization_url": authorization_url})


def disconnect_assistant_account(
    team_id: object,
    assistant_id: object,
    account_id: object,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    assistant = canonical_assistant_id(assistant_id)
    account = canonical_assistant_id(account_id)
    response = _call(
        "DELETE",
        f"/v1/teams/{canonical_id}/assistant-accounts/{assistant}/{account}",
    )
    if not 200 <= response.status < 300:
        return response
    if (
        response.status != 200
        or set(response.body) != {"disconnected"}
        or type(response.body["disconnected"]) is not bool
    ):
        log.warning("team-driver returned an invalid OAuth disconnect response")
        return DriverResponse(502, {"detail": "OAuth disconnect response is invalid."})
    return DriverResponse(204, {})


def complete_cloudflare_oauth_callback(*, state: object, claim: object, session_binding: object) -> DriverResponse:
    identifier = canonical_oauth_binding(state)
    one_time_claim = canonical_oauth_claim(claim)
    binding = canonical_oauth_binding(session_binding)
    response = _call(
        "POST",
        "/v1/oauth/cloudflare/callback",
        {"state": identifier, "claim": one_time_claim, "session_binding": binding},
    )
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"connected", "team_id", "assistant_id", "account_id"}:
            raise ValueError("invalid OAuth callback response")
        if response.body["connected"] is not True:
            raise ValueError("invalid OAuth callback response")
        body = {
            "connected": True,
            "team_id": canonical_team_id(response.body["team_id"]),
            "assistant_id": canonical_assistant_id(response.body["assistant_id"]),
            "account_id": canonical_assistant_id(response.body["account_id"]),
        }
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team-driver returned an invalid OAuth callback response")
        return DriverResponse(502, {"detail": "OAuth callback response is invalid."})
    return DriverResponse(200, body)


def list_assistants() -> DriverResponse:
    """Return the team-driver's trusted, admission-controlled catalog."""
    return _call("GET", "/v1/assistants")


def _assistant_path(team_id: object, assistant_id: object | None = None) -> str:
    canonical_id = canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/assistants"
    return base if assistant_id is None else f"{base}/{canonical_assistant_id(assistant_id)}"


def list_installed_assistants(team_id: object) -> DriverResponse:
    return _call("GET", _assistant_path(team_id))


def assistant_help(team_id: object, assistant_id: object, locale: object = "en") -> DriverResponse:
    """Return one installed Assistant's bounded, controller-owned Help document."""
    canonical_locale = canonical_assistant_help_locale(locale)
    return _call("GET", f"{_assistant_path(team_id, assistant_id)}/help/{canonical_locale}")


def install_assistant(team_id: object, payload: object) -> DriverResponse:
    if not isinstance(payload, dict) or set(payload) != {"assistant"}:
        raise TeamRequestError("request body must contain only assistant")
    assistant_id = canonical_assistant_id(payload["assistant"])
    return _call("POST", _assistant_path(team_id), {"assistant": assistant_id})


def uninstall_assistant(team_id: object, assistant_id: object) -> DriverResponse:
    return _call("DELETE", _assistant_path(team_id, assistant_id))


def _files_path(team_id: object, file_id: object | None = None) -> str:
    canonical_id = canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/files"
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


def _project_storage_response(response: DriverResponse, *, team_id: str, kind: str) -> DriverResponse:
    if not 200 <= response.status < 300:
        error_body = {
            key: value
            for key in ("detail", "error", "code")
            if isinstance((value := response.body.get(key)), str) and 0 < len(value) <= 500
        }
        if not error_body:
            error_body = {"detail": "team-driver request failed"}
        return DriverResponse(response.status, error_body)
    try:
        if response.body.get("team_id") != team_id:
            raise ValueError("invalid Team identity")
        if kind == "upload":
            body: dict[str, object] = {
                "team_id": team_id,
                "file": _file_metadata(response.body.get("file"), include_usage=True),
            }
        elif kind == "list":
            files = response.body.get("files")
            if not isinstance(files, list) or len(files) > 256:
                raise ValueError("invalid file inventory")
            body = {
                "team_id": team_id,
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
            body = {"team_id": team_id, "id": file_id, "deleted": deleted, **_usage(response.body)}
        else:
            raise ValueError("invalid storage response kind")
    except TeamRequestError, TypeError, ValueError:
        log.warning("team-driver returned an invalid storage response (%s)", kind)
        return DriverResponse(502, {"detail": "team-driver unavailable"})
    return DriverResponse(response.status, body)


def upload_file(team_id: object, filename: object, media_type: object, content: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    safe_filename = canonical_filename(filename)
    safe_media_type = canonical_media_type(media_type)
    if not isinstance(content, bytes) or not content:
        raise TeamRequestError("file must contain bytes")
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        raise TeamRequestError(f"file exceeds {MAX_FILE_UPLOAD_BYTES} bytes")
    payload = {
        "filename": safe_filename,
        "media_type": safe_media_type,
        "content_b64": base64.b64encode(content).decode("ascii"),
    }
    response = _call("POST", _files_path(canonical_id), payload, max_body_bytes=MAX_FILE_JSON_BODY_BYTES)
    return _project_storage_response(response, team_id=canonical_id, kind="upload")


def list_files(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    response = _call("GET", _files_path(canonical_id))
    return _project_storage_response(response, team_id=canonical_id, kind="list")


def delete_file(team_id: object, file_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    response = _call("DELETE", _files_path(canonical_id, file_id))
    return _project_storage_response(response, team_id=canonical_id, kind="delete")
