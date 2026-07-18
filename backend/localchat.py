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

import capsules
import modelproviders

_MISSING_RUNTIME_STATUSES = frozenset({HTTPStatus.NOT_FOUND, HTTPStatus.METHOD_NOT_ALLOWED, HTTPStatus.NOT_IMPLEMENTED})
MAX_REPLY_CHARS = 64 * 1024
MAX_TEAM_NAME_CHARS = 80
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_TURN_RESPONSE_FIELDS = frozenset({"capsule", "team", "reply", "trace_id"})
_STOP_RESPONSE_FIELDS = frozenset({"capsule", "requested", "accepted", "confirmed", "forced_restart", "trace_id"})


def _unavailable() -> capsules.DriverResponse:
    return capsules.DriverResponse(
        HTTPStatus.SERVICE_UNAVAILABLE,
        {"detail": "local chat runtime is unavailable; update this Shimpz Space"},
    )


def _safe_error(response: capsules.DriverResponse, *, secret: str | None = None) -> capsules.DriverResponse:
    detail = response.body.get("detail") or response.body.get("error")
    if not isinstance(detail, str) or not 0 < len(detail) <= 500 or (secret and secret in detail):
        detail = "local chat request failed"
    return capsules.DriverResponse(response.status, {"detail": detail})


def _inference(capsule_id: str) -> tuple[str, str] | capsules.DriverResponse:
    response = capsules.get_inference(capsule_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    provider = response.body.get("provider")
    model = response.body.get("model")
    try:
        provider = modelproviders.canonical_provider(provider)
    except modelproviders.ModelProviderError:
        return capsules.DriverResponse(HTTPStatus.BAD_GATEWAY, {"detail": "Capsule inference response is invalid"})
    if not isinstance(model, str) or capsules._MODEL_RE.fullmatch(model) is None:
        return capsules.DriverResponse(HTTPStatus.BAD_GATEWAY, {"detail": "Capsule inference response is invalid"})
    return provider, model


def turn(capsule_id: object, payload: object) -> capsules.DriverResponse:
    cid = capsules.canonical_capsule_id(capsule_id)
    body = capsules.canonical_chat_payload(payload)
    inference = _inference(cid)
    if isinstance(inference, capsules.DriverResponse):
        return inference
    provider, _model = inference
    try:
        api_key = modelproviders.resolve_api_key(provider)
    except modelproviders.ModelProviderError:
        return capsules.DriverResponse(HTTPStatus.BAD_GATEWAY, {"detail": "model credential store is invalid"})
    if api_key is None:
        return capsules.DriverResponse(
            HTTPStatus.CONFLICT,
            {"detail": f"add a {provider} API key before chatting"},
        )

    response = capsules.chat(cid, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response, secret=api_key)

    capsule = response.body.get("capsule")
    team = response.body.get("team")
    reply = response.body.get("reply")
    if (
        set(response.body) != _TURN_RESPONSE_FIELDS
        or capsule != cid
        or not _valid_trace_id(response.body.get("trace_id"))
        or not _valid_team_name(team)
        or not isinstance(reply, str)
        or not 0 < len(reply) <= MAX_REPLY_CHARS
        or api_key in team
        or api_key in reply
    ):
        return capsules.DriverResponse(HTTPStatus.BAD_GATEWAY, {"detail": "local chat response is invalid"})
    return capsules.DriverResponse(response.status, {"capsule": cid, "team": team, "reply": reply})


def _valid_team_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= MAX_TEAM_NAME_CHARS
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _valid_trace_id(value: object) -> bool:
    return isinstance(value, str) and _TRACE_ID_RE.fullmatch(value) is not None


def stop(capsule_id: object) -> capsules.DriverResponse:
    cid = capsules.canonical_capsule_id(capsule_id)
    response = capsules.stop_chat(cid)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    capsule = response.body.get("capsule")
    requested = response.body.get("requested")
    accepted = response.body.get("accepted")
    confirmed = response.body.get("confirmed")
    forced_restart = response.body.get("forced_restart")
    if (
        set(response.body) != _STOP_RESPONSE_FIELDS
        or capsule != cid
        or not _valid_trace_id(response.body.get("trace_id"))
        or not all(isinstance(value, bool) for value in (requested, accepted, confirmed, forced_restart))
        or requested != accepted
        or ((confirmed or forced_restart) and not accepted)
    ):
        return capsules.DriverResponse(HTTPStatus.BAD_GATEWAY, {"detail": "local chat stop response is invalid"})
    # ``accepted`` means the active turn token was cancelled and any late provider reply will be
    # discarded. ``confirmed`` describes only a Power subprocess, not the whole turn.
    return capsules.DriverResponse(response.status, {"capsule": cid, "stopped": accepted})
