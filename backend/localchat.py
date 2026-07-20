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

import json
import math
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
_CONNECTION_CHALLENGE_RESPONSE_FIELDS = frozenset(
    {"team_id", "status", "turn_id", "challenge_id", "expires_in", "requirements", "trace_id"}
)
_INVENTORY_RESPONSE_FIELDS = frozenset({"team_id", "assistants", "trace_id"})
_CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_SECRET_REQUIREMENTS = 16
MAX_SECRETS_PER_CHALLENGE = 64
MAX_SECRET_LABEL_CHARS = 80
MAX_SECRET_SUMMARY_CHARS = 160
MAX_INSTALLED_ASSISTANTS = 128
MAX_APPROVAL_REQUIREMENTS = 64
MAX_CONNECTION_REQUIREMENTS = 64
MAX_CONNECTION_SCOPES = 32
MAX_CONNECTION_POWERS = 128
MAX_CONNECTION_SCOPE_CHARS = 128
MAX_APPROVAL_INPUT_BYTES = 32 * 1024
MAX_APPROVAL_INPUT_TOTAL_BYTES = 128 * 1024
MAX_APPROVAL_JSON_DEPTH = 16
MAX_APPROVAL_JSON_NODES = 1024
MAX_REMEMBERED_APPROVALS = 8192


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


def _bounded_approval_input(value: object) -> dict[str, object]:
    budget = [MAX_APPROVAL_JSON_NODES]

    def walk(node: object, depth: int) -> None:
        budget[0] -= 1
        if budget[0] < 0 or depth > MAX_APPROVAL_JSON_DEPTH:
            raise ValueError("approval input exceeds its structure limit")
        if node is None or isinstance(node, bool | str):
            return
        if isinstance(node, int) and not isinstance(node, bool):
            return
        if isinstance(node, float):
            if not math.isfinite(node):
                raise ValueError("approval input contains a non-finite number")
            return
        if isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
            return
        if isinstance(node, dict):
            for key, item in node.items():
                if not isinstance(key, str) or len(key) > 128:
                    raise ValueError("approval input key is invalid")
                walk(item, depth + 1)
            return
        raise ValueError("approval input is not JSON")

    if not isinstance(value, dict):
        raise ValueError("approval input must be an object")
    walk(value, 0)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode()
    if len(encoded) > MAX_APPROVAL_INPUT_BYTES:
        raise ValueError("approval input exceeds its byte limit")
    return value


def _project_approval_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    try:
        if set(response.body) != _CHALLENGE_RESPONSE_FIELDS:
            raise ValueError("invalid approval envelope")
        if (
            response.body["team_id"] != team_id
            or response.body["status"] != "approval-required"
            or not _valid_trace_id(response.body["trace_id"])
        ):
            raise ValueError("invalid approval identity")
        challenge_id = response.body["challenge_id"]
        turn_id = response.body["turn_id"]
        raw_requirements = response.body["requirements"]
        if (
            not isinstance(challenge_id, str)
            or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None
            or not isinstance(turn_id, str)
            or _CHALLENGE_ID_RE.fullmatch(turn_id) is None
            or not isinstance(raw_requirements, list)
            or not 1 <= len(raw_requirements) <= MAX_APPROVAL_REQUIREMENTS
        ):
            raise ValueError("invalid approval metadata")
        requirements: list[dict[str, object]] = []
        total_input_bytes = 0
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "power_id",
                "power_summary",
                "input",
                "approval",
            }:
                raise ValueError("invalid approval requirement")
            assistant_id = teams.canonical_assistant_id(raw["assistant_id"])
            power_id = teams.canonical_assistant_id(raw["power_id"])
            if raw["approval"] not in {"each-run", "once"}:
                raise ValueError("invalid approval policy")
            power_input = _bounded_approval_input(raw["input"])
            total_input_bytes += len(
                json.dumps(
                    power_input,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode()
            )
            if total_input_bytes > MAX_APPROVAL_INPUT_TOTAL_BYTES:
                raise ValueError("approval inputs exceed their aggregate byte limit")
            requirements.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": _clean_public_text(raw["assistant_name"], MAX_SECRET_LABEL_CHARS),
                    "power_id": power_id,
                    "power_summary": _clean_public_text(raw["power_summary"], MAX_SECRET_SUMMARY_CHARS),
                    "input": power_input,
                    "approval": "always" if raw["approval"] == "each-run" else "once",
                }
            )
    except KeyError, TypeError, ValueError, UnicodeError, teams.TeamRequestError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-challenge-response-invalid"})
    return teams.DriverResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "approval-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "requirements": requirements,
        },
    )


def _project_connection_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    """Project an OAuth consent gate without exposing any authorization material."""
    try:
        if set(response.body) != _CONNECTION_CHALLENGE_RESPONSE_FIELDS:
            raise ValueError("invalid connection envelope")
        if (
            response.body["team_id"] != team_id
            or response.body["status"] != "connections-required"
            or not _valid_trace_id(response.body["trace_id"])
        ):
            raise ValueError("invalid connection identity")
        challenge_id = response.body["challenge_id"]
        turn_id = response.body["turn_id"]
        expires_in = response.body["expires_in"]
        raw_requirements = response.body["requirements"]
        if (
            not isinstance(challenge_id, str)
            or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None
            or not isinstance(turn_id, str)
            or _CHALLENGE_ID_RE.fullmatch(turn_id) is None
            or not isinstance(expires_in, int)
            or isinstance(expires_in, bool)
            or not 1 <= expires_in <= 900
            or not isinstance(raw_requirements, list)
            or not 1 <= len(raw_requirements) <= MAX_CONNECTION_REQUIREMENTS
        ):
            raise ValueError("invalid connection metadata")

        requirements: list[dict[str, object]] = []
        seen_connections: set[tuple[str, str]] = set()
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "connection_id",
                "provider",
                "name",
                "summary",
                "scopes",
                "powers",
            }:
                raise ValueError("invalid connection requirement")
            assistant_id = teams.canonical_assistant_id(raw["assistant_id"])
            connection_id = teams.canonical_assistant_id(raw["connection_id"])
            identity = (assistant_id, connection_id)
            if identity in seen_connections:
                raise ValueError("duplicate connection")
            seen_connections.add(identity)

            raw_scopes = raw["scopes"]
            raw_powers = raw["powers"]
            if (
                not isinstance(raw_scopes, list)
                or not 1 <= len(raw_scopes) <= MAX_CONNECTION_SCOPES
                or not isinstance(raw_powers, list)
                or not 1 <= len(raw_powers) <= MAX_CONNECTION_POWERS
            ):
                raise ValueError("invalid connection capabilities")
            scopes = [_clean_public_text(scope, MAX_CONNECTION_SCOPE_CHARS) for scope in raw_scopes]
            if len(set(scopes)) != len(scopes):
                raise ValueError("duplicate connection scope")

            powers: list[dict[str, str]] = []
            seen_powers: set[str] = set()
            for raw_power in raw_powers:
                if not isinstance(raw_power, dict) or set(raw_power) != {"id", "name", "summary"}:
                    raise ValueError("invalid connection Power")
                power_id = teams.canonical_assistant_id(raw_power["id"])
                if power_id in seen_powers:
                    raise ValueError("duplicate connection Power")
                seen_powers.add(power_id)
                powers.append(
                    {
                        "id": power_id,
                        "name": _clean_public_text(raw_power["name"], MAX_SECRET_LABEL_CHARS),
                        "summary": _clean_public_text(raw_power["summary"], MAX_SECRET_SUMMARY_CHARS),
                    }
                )
            requirements.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": _clean_public_text(raw["assistant_name"], MAX_SECRET_LABEL_CHARS),
                    "connection_id": connection_id,
                    "provider": teams.canonical_assistant_id(raw["provider"]),
                    "name": _clean_public_text(raw["name"], MAX_SECRET_LABEL_CHARS),
                    "summary": _clean_public_text(raw["summary"], MAX_SECRET_SUMMARY_CHARS),
                    "scopes": scopes,
                    "powers": powers,
                }
            )
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "connection-challenge-response-invalid"})
    return teams.DriverResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "connections-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "expires_in": expires_in,
            "requirements": requirements,
        },
    )


def _project_pending_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    status = response.body.get("status")
    if status == "connections-required":
        return _project_connection_challenge(response, team_id)
    if status == "secrets-required":
        return _project_challenge(response, team_id)
    if status == "approval-required":
        return _project_approval_challenge(response, team_id)
    return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-challenge-response-invalid"})


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
        return _project_pending_challenge(response, canonical_id)
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
        return _project_pending_challenge(response, canonical_id)
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


def pending_connections(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.pending_chat_connections(canonical_id)
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
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "connection-challenge-response-invalid"})
    return _project_connection_challenge(response, canonical_id)


def resume_connections(team_id: object, challenge_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_connection_resume({"challenge_id": challenge_id})
    credential = _model_credential(canonical_id)
    if isinstance(credential, teams.DriverResponse):
        return credential
    provider, api_key = credential
    response = teams.resume_chat_connections(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_pending_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)
    return _project_turn(response, canonical_id, forbidden_values=(api_key,))


def submit_approval(team_id: object, payload: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_approval_submission(payload)
    credential = _model_credential(canonical_id)
    if isinstance(credential, teams.DriverResponse):
        return credential
    provider, api_key = credential
    response = teams.submit_chat_approval(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_pending_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)
    return _project_turn(response, canonical_id, forbidden_values=(api_key,))


def pending_approval(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.pending_chat_approval(canonical_id)
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
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-challenge-response-invalid"})
    return _project_approval_challenge(response, canonical_id)


def secret_inventory(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    return _project_inventory(teams.list_assistant_secrets(canonical_id), canonical_id)


def replace_secrets(team_id: object, payload: object) -> teams.DriverResponse:
    """Atomically rotate a declared subset, then expose only controller-owned masks."""
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_secret_replacement(payload)
    response = teams.replace_assistant_secrets(canonical_id, body)
    return _project_inventory(response, canonical_id)


def approval_inventory(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.list_assistant_approvals(canonical_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    try:
        if set(response.body) != {"team_id", "grants", "trace_id"}:
            raise ValueError("invalid approval inventory")
        if response.body["team_id"] != canonical_id or not _valid_trace_id(response.body["trace_id"]):
            raise ValueError("invalid approval inventory identity")
        raw_grants = response.body["grants"]
        if not isinstance(raw_grants, list) or len(raw_grants) > MAX_REMEMBERED_APPROVALS:
            raise ValueError("invalid approval inventory count")
        grants: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for raw in raw_grants:
            if not isinstance(raw, dict) or set(raw) != {"assistant_id", "power_id"}:
                raise ValueError("invalid approval grant")
            item = {
                "assistant_id": teams.canonical_assistant_id(raw["assistant_id"]),
                "power_id": teams.canonical_assistant_id(raw["power_id"]),
            }
            identity = (item["assistant_id"], item["power_id"])
            if identity in seen:
                raise ValueError("duplicate approval grant")
            seen.add(identity)
            grants.append(item)
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-inventory-response-invalid"})
    return teams.DriverResponse(response.status, {"team_id": canonical_id, "grants": grants})


def revoke_approvals(team_id: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    response = teams.revoke_assistant_approvals(canonical_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    revoked = response.body.get("revoked")
    if (
        set(response.body) != {"team_id", "revoked", "trace_id"}
        or response.body.get("team_id") != canonical_id
        or type(revoked) is not int
        or not 0 <= revoked <= MAX_REMEMBERED_APPROVALS
        or not _valid_trace_id(response.body.get("trace_id"))
    ):
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-inventory-response-invalid"})
    return teams.DriverResponse(response.status, {"team_id": canonical_id, "revoked": revoked})


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
