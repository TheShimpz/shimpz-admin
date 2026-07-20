"""Secret-safe local Team chat orchestration for the Admin backend.

The browser contract is always ``message/files/assistant_ids``. The requested Assistant IDs are
only a scope: the controller still verifies that every selected Assistant is installed and running.
An empty scope means Brain-only and is never expanded to all installed Assistants. This backend
reads controller-owned inference metadata, resolves its API key from ``admin.json`` through the
non-route ``modelproviders.resolve_api_key``, then delivers it only in fixed private headers on the
authenticated control network. Successful and failed controller responses are reprojected so a
buggy controller can never echo that key or internal execution details back to the browser.
"""

from __future__ import annotations

import re
from http import HTTPStatus

import modelproviders
import teams

_MISSING_RUNTIME_STATUSES = frozenset({HTTPStatus.NOT_FOUND, HTTPStatus.METHOD_NOT_ALLOWED, HTTPStatus.NOT_IMPLEMENTED})
MAX_REPLY_CHARS = 64 * 1024
MAX_TEAM_NAME_CHARS = 80
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_TURN_RESPONSE_FIELDS = frozenset({"team_id", "team_name", "reply", "trace_id"})
_STOP_RESPONSE_FIELDS = frozenset({"team_id", "requested", "accepted", "confirmed", "forced_restart", "trace_id"})
_CHALLENGE_RESPONSE_FIELDS = frozenset({"team_id", "status", "turn_id", "challenge_id", "requirements", "trace_id"})
_INVENTORY_RESPONSE_FIELDS = frozenset({"team_id", "assistants", "trace_id"})
_CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_SECRET_REQUIREMENTS = 16
MAX_SECRETS_PER_CHALLENGE = 64
MAX_SECRET_LABEL_CHARS = 80
MAX_SECRET_SUMMARY_CHARS = 160
MAX_INSTALLED_ASSISTANTS = 128


def _unavailable() -> teams.DriverResponse:
    return teams.DriverResponse(
        HTTPStatus.SERVICE_UNAVAILABLE,
        {"code": "runtime-unavailable"},
    )


def _safe_error(response: teams.DriverResponse) -> teams.DriverResponse:
    """Reduce one authenticated controller failure to a bounded, non-secret machine code."""
    code = response.body.get("code")
    if not isinstance(code, str) or len(code) > 80 or _ERROR_CODE_RE.fullmatch(code) is None:
        code = "chat-request-failed"
    return teams.DriverResponse(response.status, {"code": code})


def _inference(team_id: str) -> tuple[str, str] | teams.DriverResponse:
    response = teams.get_inference(team_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    provider = response.body.get("provider")
    model = response.body.get("model")
    try:
        selected_provider = modelproviders.canonical_provider(provider)
        selected_model = modelproviders.canonical_model(selected_provider, model)
    except modelproviders.ModelProviderError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    if provider != selected_provider:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    return selected_provider, selected_model


def _model_credential(team_id: str) -> tuple[str, str] | teams.DriverResponse:
    inference = _inference(team_id)
    if isinstance(inference, teams.DriverResponse):
        return inference
    provider, _model = inference
    try:
        api_key = modelproviders.resolve_api_key(provider)
    except modelproviders.ModelProviderError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "model-credential-store-invalid"})
    if api_key is None:
        return teams.DriverResponse(HTTPStatus.CONFLICT, {"code": "model-credential-missing"})
    return provider, api_key


def _clean_public_text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid public text")
    return value


def _project_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    try:
        if set(response.body) != _CHALLENGE_RESPONSE_FIELDS:
            raise ValueError("invalid challenge envelope")
        if (
            response.body["team_id"] != team_id
            or response.body["status"] != "secrets-required"
            or not _valid_trace_id(response.body["trace_id"])
        ):
            raise ValueError("invalid challenge identity")
        challenge_id = response.body["challenge_id"]
        turn_id = response.body["turn_id"]
        raw_requirements = response.body["requirements"]
        if (
            not isinstance(challenge_id, str)
            or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None
            or not isinstance(turn_id, str)
            or _CHALLENGE_ID_RE.fullmatch(turn_id) is None
            or not isinstance(raw_requirements, list)
            or not 1 <= len(raw_requirements) <= MAX_SECRET_REQUIREMENTS
        ):
            raise ValueError("invalid challenge metadata")
        requirements: list[dict[str, object]] = []
        seen_assistants: set[str] = set()
        total_secrets = 0
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "power_ids",
                "secrets",
            }:
                raise ValueError("invalid requirement")
            assistant_id = teams.canonical_assistant_id(raw["assistant_id"])
            if assistant_id in seen_assistants:
                raise ValueError("duplicate Assistant")
            seen_assistants.add(assistant_id)
            assistant_name = _clean_public_text(raw["assistant_name"], MAX_SECRET_LABEL_CHARS)
            power_ids = raw["power_ids"]
            raw_secrets = raw["secrets"]
            if not isinstance(power_ids, list) or not power_ids or not isinstance(raw_secrets, list) or not raw_secrets:
                raise ValueError("empty requirement")
            canonical_powers = [teams.canonical_assistant_id(item) for item in power_ids]
            if len(set(canonical_powers)) != len(canonical_powers):
                raise ValueError("duplicate Power")
            projected_secrets: list[dict[str, str]] = []
            seen_secrets: set[str] = set()
            for secret in raw_secrets:
                if not isinstance(secret, dict) or set(secret) != {"id", "name", "summary"}:
                    raise ValueError("invalid secret metadata")
                secret_id = teams.canonical_assistant_id(secret["id"])
                if secret_id in seen_secrets:
                    raise ValueError("duplicate secret")
                seen_secrets.add(secret_id)
                projected_secrets.append(
                    {
                        "id": secret_id,
                        "name": _clean_public_text(secret["name"], MAX_SECRET_LABEL_CHARS),
                        "summary": _clean_public_text(secret["summary"], MAX_SECRET_SUMMARY_CHARS),
                    }
                )
            total_secrets += len(projected_secrets)
            if total_secrets > MAX_SECRETS_PER_CHALLENGE:
                raise ValueError("too many secrets")
            requirements.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": assistant_name,
                    "power_ids": canonical_powers,
                    "secrets": projected_secrets,
                }
            )
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "secret-challenge-response-invalid"})
    return teams.DriverResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "secrets-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "requirements": requirements,
        },
    )


def _project_inventory(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    try:
        if set(response.body) != _INVENTORY_RESPONSE_FIELDS:
            raise ValueError("invalid inventory envelope")
        if response.body["team_id"] != team_id or not _valid_trace_id(response.body["trace_id"]):
            raise ValueError("invalid inventory identity")
        raw_assistants = response.body["assistants"]
        if not isinstance(raw_assistants, list) or len(raw_assistants) > MAX_INSTALLED_ASSISTANTS:
            raise ValueError("invalid Assistant inventory")
        assistants: list[dict[str, object]] = []
        seen_assistants: set[str] = set()
        for raw in raw_assistants:
            if not isinstance(raw, dict) or set(raw) != {"id", "name", "secrets"}:
                raise ValueError("invalid Assistant inventory item")
            assistant_id = teams.canonical_assistant_id(raw["id"])
            if assistant_id in seen_assistants:
                raise ValueError("duplicate Assistant")
            seen_assistants.add(assistant_id)
            raw_secrets = raw["secrets"]
            if not isinstance(raw_secrets, list) or len(raw_secrets) > 32:
                raise ValueError("invalid secret inventory")
            secrets: list[dict[str, object]] = []
            seen_secrets: set[str] = set()
            for secret in raw_secrets:
                if not isinstance(secret, dict) or set(secret) != {
                    "id",
                    "name",
                    "summary",
                    "configured",
                    "mask",
                }:
                    raise ValueError("invalid secret inventory item")
                secret_id = teams.canonical_assistant_id(secret["id"])
                configured = secret["configured"]
                mask = secret["mask"]
                if (
                    secret_id in seen_secrets
                    or not isinstance(configured, bool)
                    or (configured and (not isinstance(mask, str) or not 1 <= len(mask) <= 9))
                    or (not configured and mask is not None)
                ):
                    raise ValueError("invalid secret inventory status")
                seen_secrets.add(secret_id)
                secrets.append(
                    {
                        "id": secret_id,
                        "name": _clean_public_text(secret["name"], MAX_SECRET_LABEL_CHARS),
                        "summary": _clean_public_text(secret["summary"], MAX_SECRET_SUMMARY_CHARS),
                        "configured": configured,
                        "mask": mask,
                    }
                )
            assistants.append(
                {
                    "id": assistant_id,
                    "name": _clean_public_text(raw["name"], MAX_SECRET_LABEL_CHARS),
                    "secrets": secrets,
                }
            )
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "secret-inventory-response-invalid"})
    return teams.DriverResponse(response.status, {"team_id": team_id, "assistants": assistants})


def _project_turn(
    response: teams.DriverResponse,
    team_id: str,
    *,
    forbidden_values: tuple[str, ...],
) -> teams.DriverResponse:
    response_team_id = response.body.get("team_id")
    team_name = response.body.get("team_name")
    reply = response.body.get("reply")
    if (
        set(response.body) != _TURN_RESPONSE_FIELDS
        or response_team_id != team_id
        or not _valid_trace_id(response.body.get("trace_id"))
        or not _valid_team_name(team_name)
        or not isinstance(reply, str)
        or not 0 < len(reply) <= MAX_REPLY_CHARS
        or any(value and (value in team_name or value in reply) for value in forbidden_values)
    ):
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-response-invalid"})
    return teams.DriverResponse(
        response.status,
        {"team_id": team_id, "team_name": team_name, "reply": reply},
    )


def turn(team_id: object, payload: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_chat_payload(payload)
    credential = _model_credential(canonical_id)
    if isinstance(credential, teams.DriverResponse):
        return credential
    provider, api_key = credential

    response = teams.chat(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)

    return _project_turn(response, canonical_id, forbidden_values=(api_key,))


def submit_secrets(team_id: object, payload: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_secret_submission(payload)
    credential = _model_credential(canonical_id)
    if isinstance(credential, teams.DriverResponse):
        return credential
    provider, api_key = credential
    response = teams.submit_chat_secrets(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)
    submitted_values = tuple(item["value"] for item in body["values"])
    return _project_turn(response, canonical_id, forbidden_values=(api_key, *submitted_values))


def pending_secrets(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.pending_chat_secrets(canonical_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    if set(response.body) == {"team_id", "status", "trace_id"}:
        if (
            response.body.get("team_id") == canonical_id
            and response.body.get("status") == "none"
            and _valid_trace_id(response.body.get("trace_id"))
        ):
            return teams.DriverResponse(response.status, {"team_id": canonical_id, "status": "none"})
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "secret-challenge-response-invalid"})
    return _project_challenge(response, canonical_id)


def secret_inventory(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    return _project_inventory(teams.list_assistant_secrets(canonical_id), canonical_id)


def replace_secrets(team_id: object, payload: object) -> teams.DriverResponse:
    """Atomically rotate a declared subset, then expose only controller-owned masks."""
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_secret_replacement(payload)
    response = teams.replace_assistant_secrets(canonical_id, body)
    return _project_inventory(response, canonical_id)


def _valid_team_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= MAX_TEAM_NAME_CHARS
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _valid_trace_id(value: object) -> bool:
    return isinstance(value, str) and _TRACE_ID_RE.fullmatch(value) is not None


def stop(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.stop_chat(canonical_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    response_team_id = response.body.get("team_id")
    requested = response.body.get("requested")
    accepted = response.body.get("accepted")
    confirmed = response.body.get("confirmed")
    forced_restart = response.body.get("forced_restart")
    if (
        set(response.body) != _STOP_RESPONSE_FIELDS
        or response_team_id != canonical_id
        or not _valid_trace_id(response.body.get("trace_id"))
        or not all(isinstance(value, bool) for value in (requested, accepted, confirmed, forced_restart))
        or requested != accepted
        or ((confirmed or forced_restart) and not accepted)
    ):
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-stop-response-invalid"})
    # ``accepted`` means the active turn token was cancelled and any late provider reply will be
    # discarded. ``confirmed`` describes only a Power subprocess, not the whole turn.
    return teams.DriverResponse(response.status, {"team_id": canonical_id, "stopped": accepted})
