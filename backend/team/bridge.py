"""Bounded Admin -> team bridge for Teams and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
team owns runtime lifecycle and admission; this module reaches only its fixed internal
HTTP routes with the existing bearer file.  Team JSON and HTTP status codes are preserved so a
safe 400/404/409 is not flattened into an ambiguous gateway error.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable

import models
from team import transport

from chat import payloads
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

log = logging.getLogger("shimpz-admin")

CONTROL_TIMEOUT_SECONDS = transport.CONTROL_TIMEOUT_SECONDS
MAX_JSON_BODY_BYTES = transport.MAX_JSON_BODY_BYTES
MAX_JSON_RESPONSE_BYTES = transport.MAX_JSON_RESPONSE_BYTES
TeamResponse = transport.TeamResponse
TeamRequestError = transport.TeamRequestError
_call = transport._call
_call_raw = transport._call_raw
_call_stream = transport._call_stream
supervisor_session = transport.supervisor_session

MAX_CHAT_JSON_BODY_BYTES = 128 * 1024
MAX_FILE_UPLOAD_BYTES = team_contract.MAX_FILE_UPLOAD_BYTES

_FILE_ID_RE = team_contract.FILE_ID_RE
MAX_TEAMS = 128
MAX_TEAM_NAME_CHARS = team_contract.MAX_TEAM_NAME_CHARS
_LATIN_ASCII_EXPANSIONS = str.maketrans(
    {"æ": "ae", "đ": "d", "ð": "d", "ı": "i", "ł": "l", "ø": "o", "œ": "oe", "þ": "th"}
)


def to_team_id(team_name: object) -> str:
    """A Team name -> the Docker/Postgres-safe id used by team."""
    folded = unicodedata.normalize("NFKD", str(team_name).casefold().translate(_LATIN_ASCII_EXPANSIONS))
    ascii_name = folded.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9_]+", "_", ascii_name).strip("_")[:40]


def canonical_team_id(value: object) -> str:
    canonical = team_contract.canonical_team_id(value)
    if canonical is None:
        raise TeamRequestError("team id must be a canonical lowercase identifier")
    return canonical


def canonical_team_name(value: object) -> str:
    canonical = team_contract.canonical_team_name(value)
    if canonical is None:
        raise TeamRequestError("team name must contain 1 to 80 trimmed characters")
    return canonical


canonical_assistant_id = payloads.canonical_assistant_id
_SOURCE_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def canonical_source_digest(value: object) -> str:
    if not isinstance(value, str) or _SOURCE_DIGEST_RE.fullmatch(value) is None:
        raise TeamRequestError("source digest must be a canonical sha256 digest")
    return value


canonical_challenge_id = payloads.canonical_challenge_id


def canonical_filename(value: object) -> str:
    canonical = team_contract.canonical_filename(value)
    if canonical is None:
        raise TeamRequestError("filename must be a trimmed, non-path UTF-8 name")
    return canonical


def canonical_media_type(value: object) -> str:
    media_type = team_contract.canonical_media_type(value)
    if media_type is None:
        raise TeamRequestError("invalid media type")
    return media_type


def list_teams() -> TeamResponse:
    return _call("GET", "/v1/teams")


def reset_space() -> TeamResponse:
    return _call("DELETE", "/v1/space")


def create(team_id: object, team_name: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    if not isinstance(team_name, str) or not team_name.strip() or len(team_name) > MAX_TEAM_NAME_CHARS:
        raise TeamRequestError("team name must be between 1 and 80 characters")
    return _call("POST", f"/v1/teams/{canonical_id}/create", {"team_name": team_name.strip()})


def _authoritative_team_name(response: TeamResponse, team_id: str) -> TeamResponse | str:
    """Project one strict Team identity from the controller inventory before destruction."""
    if not 200 <= response.status < 300:
        return response
    try:
        allowed_envelope = {"teams"}
        if "trace_id" in response.body:
            allowed_envelope.add("trace_id")
            trace_id = response.body["trace_id"]
            if not isinstance(trace_id, str) or chat_ws_common.HEX_ID_RE.fullmatch(trace_id) is None:
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
        log.warning("team returned an invalid Team inventory")
        return TeamResponse(502, {"detail": "Team inventory response is invalid."})
    try:
        return names[team_id]
    except KeyError:
        return TeamResponse(404, {"detail": "Team not found"})


def destroy(team_id: object, expected_team_name: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    expected_name = canonical_team_name(expected_team_name)
    authoritative = _authoritative_team_name(list_teams(), canonical_id)
    if isinstance(authoritative, TeamResponse):
        return authoritative
    if authoritative != expected_name:
        raise TeamRequestError("Team name confirmation does not match")
    return _call("DELETE", f"/v1/teams/{canonical_id}")


def _project_inference_response(
    response: TeamResponse,
    team_id: str,
    *,
    expected: tuple[str, str] | None = None,
) -> TeamResponse:
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
        selected_provider = models.canonical_provider(provider)
        selected_model = models.canonical_model(selected_provider, model)
        if (
            response_team_id != selected_team_id
            or selected_team_id != team_id
            or provider != selected_provider
            or model != selected_model
            or not isinstance(trace_id, str)
            or chat_ws_common.HEX_ID_RE.fullmatch(trace_id) is None
        ):
            raise ValueError("non-canonical inference metadata")
        if expected is not None and (selected_provider, selected_model) != expected:
            raise ValueError("mismatched inference metadata")
    except KeyError, TypeError, ValueError, TeamRequestError, models.ModelProviderError:
        # Never reflect controller fields: an invalid response could contain credentials or internals.
        log.warning("team returned an invalid inference response")
        return TeamResponse(502, {"detail": "Team inference response is invalid."})
    return TeamResponse(
        response.status,
        {"team_id": team_id, "provider": selected_provider, "model": selected_model},
    )


def get_inference(team_id: object) -> TeamResponse:
    """Read provider/model metadata only; the controller response must never contain a key."""
    canonical_id = canonical_team_id(team_id)
    response = _call("GET", f"/v1/teams/{canonical_id}/inference")
    return _project_inference_response(response, canonical_id)


def configure_inference(team_id: object, payload: object) -> TeamResponse:
    """Forward the closed, secret-free Team inference contract."""
    canonical_id = canonical_team_id(team_id)
    if not isinstance(payload, dict) or set(payload) != {"provider", "model"}:
        raise TeamRequestError("inference requires only provider and model")
    provider = payload["provider"]
    model = payload["model"]
    try:
        selected_provider = models.canonical_provider(provider)
        selected_model = models.canonical_model(selected_provider, model)
    except models.ModelProviderError as exc:
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


canonical_chat_payload = payloads.canonical_chat_payload
canonical_integration_resume = payloads.canonical_integration_resume


def chat(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    progress: Callable[[dict[str, object]], None],
) -> TeamResponse:
    """Send a turn whose JSON is secret-free; the key uses the private authenticated header."""
    canonical_id = canonical_team_id(team_id)
    body = canonical_chat_payload(payload)
    return _call_stream(
        "POST",
        f"/v1/teams/{canonical_id}/chat",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
        model_credential=(provider, api_key),
        progress=progress,
    )


def stop_chat(team_id: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("POST", f"/v1/teams/{canonical_id}/chat/stop", {})


def pending_chat_integrations(team_id: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/chat/integrations")


def resume_chat_integrations(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    progress: Callable[[dict[str, object]], None],
) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_integration_resume(payload)
    return _call_stream(
        "POST",
        f"/v1/teams/{canonical_id}/chat/integrations",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        model_credential=(provider, api_key),
        progress=progress,
    )


def list_assistants() -> TeamResponse:
    """Return the team's trusted, admission-controlled catalog."""
    return _call("GET", "/v1/assistants")


def _assistant_path(team_id: object, assistant_id: object | None = None) -> str:
    canonical_id = canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/assistants"
    return base if assistant_id is None else f"{base}/{canonical_assistant_id(assistant_id)}"


def list_installed_assistants(team_id: object) -> TeamResponse:
    return _call("GET", _assistant_path(team_id))


def install_assistant(team_id: object, payload: object) -> TeamResponse:
    if not isinstance(payload, dict) or set(payload) != {"assistant_id", "source_digest"}:
        raise TeamRequestError("request body must contain only assistant_id and source_digest")
    assistant_id = canonical_assistant_id(payload["assistant_id"])
    source_digest = canonical_source_digest(payload["source_digest"])
    return _call(
        "POST",
        _assistant_path(team_id),
        {"assistant_id": assistant_id, "source_digest": source_digest},
    )


def uninstall_assistant(team_id: object, assistant_id: object) -> TeamResponse:
    return _call("DELETE", _assistant_path(team_id, assistant_id))


def _files_path(team_id: object, file_id: object | None = None) -> str:
    canonical_id = canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/files"
    if file_id is None:
        return base
    return f"{base}/{payloads._canonical_id(file_id, field='file id', pattern=_FILE_ID_RE, maximum=32)}"


def _project_storage_response(
    response: TeamResponse,
    *,
    team_id: str,
    kind: str,
    expected_file_id: str | None = None,
) -> TeamResponse:
    if not 200 <= response.status < 300:
        error_body = {
            key: value
            for key in ("detail", "error", "code")
            if isinstance((value := response.body.get(key)), str) and 0 < len(value) <= 500
        }
        if not error_body:
            error_body = {"detail": "team request failed"}
        return TeamResponse(response.status, error_body)
    body = team_contract.project_storage_response(
        response.body,
        kind=kind,
        expected_team_id=team_id,
        expected_file_id=expected_file_id,
        include_team_id=True,
    )
    if body is None:
        log.warning("team returned an invalid storage response (%s)", kind)
        return TeamResponse(502, {"detail": "team unavailable"})
    return TeamResponse(response.status, body)


def upload_file(team_id: object, filename: object, media_type: object, content: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    safe_filename = canonical_filename(filename)
    safe_media_type = canonical_media_type(media_type)
    if not isinstance(content, bytes) or not content:
        raise TeamRequestError("file must contain bytes")
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        raise TeamRequestError(f"file exceeds {MAX_FILE_UPLOAD_BYTES} bytes")
    response = _call_raw(
        "POST",
        _files_path(canonical_id),
        content,
        filename=safe_filename,
        media_type=safe_media_type,
    )
    return _project_storage_response(response, team_id=canonical_id, kind="upload")


def list_files(team_id: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    response = _call("GET", _files_path(canonical_id))
    return _project_storage_response(response, team_id=canonical_id, kind="list")


def delete_file(team_id: object, file_id: object) -> TeamResponse:
    canonical_id = canonical_team_id(team_id)
    canonical_file_id = payloads._canonical_id(file_id, field="file id", pattern=_FILE_ID_RE, maximum=32)
    response = _call("DELETE", _files_path(canonical_id, canonical_file_id))
    return _project_storage_response(
        response,
        team_id=canonical_id,
        kind="delete",
        expected_file_id=canonical_file_id,
    )
