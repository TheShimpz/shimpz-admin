"""Bounded Admin -> team-driver bridge for Teams and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
team-driver owns runtime lifecycle and admission; this module reaches only its fixed internal
HTTP routes with the existing bearer file.  Driver JSON and HTTP status codes are preserved so a
safe 400/404/409 is not flattened into an ambiguous gateway error.
"""

from __future__ import annotations

import logging
import re

import accounts_oauth
import chat_payloads
import driver_client
import modelproviders
import team_driver_contract

log = logging.getLogger("shimpz-admin")

CONTROL_TIMEOUT_SECONDS = driver_client.CONTROL_TIMEOUT_SECONDS
MAX_JSON_BODY_BYTES = driver_client.MAX_JSON_BODY_BYTES
MAX_JSON_RESPONSE_BYTES = driver_client.MAX_JSON_RESPONSE_BYTES
DriverResponse = driver_client.DriverResponse
TeamRequestError = driver_client.TeamRequestError
_call = driver_client._call
_call_raw = driver_client._call_raw

MAX_CHAT_JSON_BODY_BYTES = 24 * 1024
MAX_SECRET_JSON_BODY_BYTES = 512 * 1024
MAX_FILE_UPLOAD_BYTES = team_driver_contract.MAX_FILE_UPLOAD_BYTES

ASSISTANT_HELP_LOCALES = frozenset({"en", "pt", "es", "zh", "fr", "de", "ja", "ar"})
_FILE_ID_RE = team_driver_contract.FILE_ID_RE
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_TEAMS = 128
MAX_TEAM_NAME_CHARS = team_driver_contract.MAX_TEAM_NAME_CHARS


def to_team_id(team_name: object) -> str:
    """A Team name -> the Docker/Postgres-safe id used by team-driver."""
    return re.sub(r"[^a-z0-9_]+", "_", str(team_name).lower()).strip("_")[:40]


def _canonical_id(value: object, *, field: str, pattern: re.Pattern[str], maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not pattern.fullmatch(value):
        raise TeamRequestError(f"{field} must be a canonical lowercase identifier")
    return value


def canonical_team_id(value: object) -> str:
    canonical = team_driver_contract.canonical_team_id(value)
    if canonical is None:
        raise TeamRequestError("team id must be a canonical lowercase identifier")
    return canonical


def canonical_team_name(value: object) -> str:
    canonical = team_driver_contract.canonical_team_name(value)
    if canonical is None:
        raise TeamRequestError("team name must contain 1 to 80 trimmed characters")
    return canonical


canonical_assistant_id = chat_payloads.canonical_assistant_id


def canonical_assistant_help_locale(value: object) -> str:
    if not isinstance(value, str) or value not in ASSISTANT_HELP_LOCALES:
        raise TeamRequestError("unsupported Assistant Help locale")
    return value


canonical_oauth_binding = accounts_oauth.canonical_oauth_binding


canonical_challenge_id = chat_payloads.canonical_challenge_id


canonical_oauth_claim = accounts_oauth.canonical_oauth_claim


def canonical_filename(value: object) -> str:
    canonical = team_driver_contract.canonical_filename(value)
    if canonical is None:
        raise TeamRequestError("filename must be a trimmed, non-path UTF-8 name")
    return canonical


def canonical_media_type(value: object) -> str:
    media_type = team_driver_contract.canonical_media_type(value)
    if media_type is None:
        raise TeamRequestError("invalid media type")
    return media_type


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


canonical_chat_payload = chat_payloads.canonical_chat_payload
canonical_secret_submission = chat_payloads.canonical_secret_submission
canonical_secret_replacement = chat_payloads.canonical_secret_replacement
canonical_approval_submission = chat_payloads.canonical_approval_submission
canonical_input_submission = chat_payloads.canonical_input_submission
canonical_account_resume = chat_payloads.canonical_account_resume


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


def pending_chat_input(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    return _call("GET", f"/v1/teams/{canonical_id}/chat/input")


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


def submit_chat_input(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    body = canonical_input_submission(payload)
    return _call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/input",
        body,
        timeout=CONTROL_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
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


list_assistant_accounts = accounts_oauth.list_assistant_accounts
start_assistant_account_authorization = accounts_oauth.start_assistant_account_authorization
disconnect_assistant_account = accounts_oauth.disconnect_assistant_account
complete_cloudflare_oauth_callback = accounts_oauth.complete_cloudflare_oauth_callback


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


def _project_storage_response(
    response: DriverResponse,
    *,
    team_id: str,
    kind: str,
    expected_file_id: str | None = None,
) -> DriverResponse:
    if not 200 <= response.status < 300:
        error_body = {
            key: value
            for key in ("detail", "error", "code")
            if isinstance((value := response.body.get(key)), str) and 0 < len(value) <= 500
        }
        if not error_body:
            error_body = {"detail": "team-driver request failed"}
        return DriverResponse(response.status, error_body)
    body = team_driver_contract.project_storage_response(
        response.body,
        kind=kind,
        expected_team_id=team_id,
        expected_file_id=expected_file_id,
        include_team_id=True,
    )
    if body is None:
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
    response = _call_raw(
        "POST",
        _files_path(canonical_id),
        content,
        filename=safe_filename,
        media_type=safe_media_type,
    )
    return _project_storage_response(response, team_id=canonical_id, kind="upload")


def list_files(team_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    response = _call("GET", _files_path(canonical_id))
    return _project_storage_response(response, team_id=canonical_id, kind="list")


def delete_file(team_id: object, file_id: object) -> DriverResponse:
    canonical_id = canonical_team_id(team_id)
    canonical_file_id = _canonical_id(file_id, field="file id", pattern=_FILE_ID_RE, maximum=32)
    response = _call("DELETE", _files_path(canonical_id, canonical_file_id))
    return _project_storage_response(
        response,
        team_id=canonical_id,
        kind="delete",
        expected_file_id=canonical_file_id,
    )
