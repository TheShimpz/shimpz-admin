"""Secret-safe local Team chat orchestration for the Admin backend.

The browser contract is always ``message/files``. The controller owns the Team's installed
Assistants and chooses their declared Powers; neither is selectable from the browser. This backend
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


def turn(team_id: object, payload: object) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = teams.canonical_chat_payload(payload)
    inference = _inference(canonical_id)
    if isinstance(inference, teams.DriverResponse):
        return inference
    provider, _model = inference
    try:
        api_key = modelproviders.resolve_api_key(provider)
    except modelproviders.ModelProviderError:
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "model-credential-store-invalid"})
    if api_key is None:
        return teams.DriverResponse(
            HTTPStatus.CONFLICT,
            {"code": "model-credential-missing"},
        )

    response = teams.chat(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)

    response_team_id = response.body.get("team_id")
    team_name = response.body.get("team_name")
    reply = response.body.get("reply")
    if (
        set(response.body) != _TURN_RESPONSE_FIELDS
        or response_team_id != canonical_id
        or not _valid_trace_id(response.body.get("trace_id"))
        or not _valid_team_name(team_name)
        or not isinstance(reply, str)
        or not 0 < len(reply) <= MAX_REPLY_CHARS
        or api_key in team_name
        or api_key in reply
    ):
        return teams.DriverResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-response-invalid"})
    return teams.DriverResponse(
        response.status,
        {"team_id": canonical_id, "team_name": team_name, "reply": reply},
    )


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
