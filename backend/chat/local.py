"""Secret-safe local Team chat orchestration for the Admin backend.

The browser contract is always ``message/files/assistant_ids``. The requested Assistant IDs are
only a scope: the controller still verifies that every selected Assistant is installed and running.
An empty scope means Brain-only and is never expanded to all installed Assistants. This backend
reads controller-owned inference metadata, resolves its API key from ``admin.json`` through the
non-route ``models.resolve_api_key``, then delivers it only in fixed private headers on the
authenticated control network. Successful and failed controller responses are reprojected so a
buggy controller can never echo that key or internal execution details back to the browser.
"""

from __future__ import annotations

import contextlib
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from http import HTTPStatus

import models
from team import bridge as team

from protocol.http.v1 import progress as progress_contract
from protocol.http.v1 import websocket as chat_ws_common

_MISSING_RUNTIME_STATUSES = frozenset({HTTPStatus.NOT_FOUND, HTTPStatus.METHOD_NOT_ALLOWED, HTTPStatus.NOT_IMPLEMENTED})
MAX_REPLY_CHARS = 60_000
MAX_TEAM_NAME_CHARS = 80
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_REPLY_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TURN_RESPONSE_FIELDS = frozenset({"team_id", "team_name", "reply", "trace_id"})
_STOP_RESPONSE_FIELDS = frozenset({"team_id", "requested", "accepted", "confirmed", "forced_restart", "trace_id"})
_INTEGRATION_CHALLENGE_RESPONSE_FIELDS = frozenset(
    {"team_id", "status", "turn_id", "challenge_id", "expires_in", "requirements", "trace_id"}
)
MAX_INTEGRATION_REQUIREMENTS = 64
MAX_INTEGRATION_SCOPES = 32
MAX_INTEGRATION_POWERS = 128
MAX_INTEGRATION_SCOPE_CHARS = 128
MAX_INTEGRATION_LABEL_CHARS = 80
MAX_INTEGRATION_SUMMARY_CHARS = 160
_CHAT_ERROR_DETAILS = {
    "assistant-power-blocked": "Assistant Power execution is blocked until it is reinstalled",
    "assistant-integration-challenge-expired": "the Assistant integration expired; retry the message",
    "assistant-integration-contract-invalid": "the Assistant integration contract changed; retry the message",
    "assistant-integration-state-unavailable": "Assistant integration state is unavailable",
    "assistant-registry-drift": "an installed Assistant is no longer available",
    "assistant-unavailable": "the Brain requested an unavailable Assistant",
    "brain-runtime-failed": "the Brain runtime could not complete the Team turn",
    "chat-active": "this Team already has an active chat turn",
    "chat-request-failed": "the local chat request failed",
    "chat-response-invalid": "the local chat returned an invalid response",
    "chat-stop-response-invalid": "the local chat stop response was invalid",
    "chat-stopped": "the chat turn was stopped",
    "file-not-found": "a selected file was not found",
    "inference-not-configured": "the Team model provider is not configured",
    "inference-provider-mismatch": "the configured model provider changed; retry",
    "inference-response-invalid": "the Team model configuration is invalid",
    "invalid-files": "the selected files are invalid",
    "invalid-power-input": "an Assistant Power received invalid input",
    "model-credential-missing": "the selected model provider needs an API key",
    "model-credential-store-invalid": "the model credential store is invalid",
    "ownership-conflict": "the Team resource ownership check failed",
    "power-state-unavailable": "Team Power execution state is unavailable",
    "runtime-unavailable": "the local chat runtime is unavailable; update this Shimpz Space",
    "integration-challenge-response-invalid": "the Assistant integration challenge was invalid",
    "team-context-changed": "the Team capabilities changed; retry",
    "team-has-no-active-assistants": "install and start at least one Assistant before chatting",
}
_CHAT_ERROR_FALLBACKS = {
    400: "invalid chat request",
    409: "chat turn could not start",
    429: "local chat capacity reached",
    503: "local chat runtime is unavailable",
}
ADMIN_PROGRESS_PHASES = frozenset({"admin-preparation", "reply-validation"})
PUBLIC_PROGRESS_PHASES = progress_contract.PHASES | ADMIN_PROGRESS_PHASES
MAX_PUBLIC_PROGRESS_EVENTS = progress_contract.MAX_EVENTS + 4


def _ignore_progress(_event: dict[str, object]) -> None:
    return


def canonical_public_progress(value: object) -> dict[str, object]:
    """Validate one metadata-only event at the Admin browser boundary."""
    if not isinstance(value, dict):
        raise ValueError("invalid public chat progress")
    origin = value.get("origin")
    phase = value.get("phase")
    state = value.get("state")
    if origin not in {"admin", "team"} or phase not in PUBLIC_PROGRESS_PHASES:
        raise ValueError("invalid public chat progress")
    if (origin == "admin") != (phase in ADMIN_PROGRESS_PHASES):
        raise ValueError("invalid public chat progress authority")
    event = {key: item for key, item in value.items() if key != "origin"}
    if origin == "admin":
        expected = {"phase", "state"} | ({"elapsed_ms"} if state == "finished" else set())
        if set(event) != expected or state not in progress_contract.STATES:
            raise ValueError("invalid Admin progress event")
        if state == "finished" and (
            type(event["elapsed_ms"]) is not int or not 0 <= event["elapsed_ms"] <= progress_contract.MAX_ELAPSED_MS
        ):
            raise ValueError("invalid Admin progress duration")
    else:
        team_event = progress_contract.canonical_event({"seq": 1, **event})
        team_event.pop("seq")
        event = team_event
    return {"origin": origin, **event}


def _progress(callback: Callable[[dict[str, object]], None], event: dict[str, object]) -> None:
    canonical = canonical_public_progress(event)
    with contextlib.suppress(Exception):
        callback(canonical)


@contextlib.contextmanager
def _admin_span(callback: Callable[[dict[str, object]], None], phase: str):
    started_ns = time.monotonic_ns()
    _progress(callback, {"origin": "admin", "phase": phase, "state": "started"})
    try:
        yield
    finally:
        elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
        _progress(
            callback,
            {
                "origin": "admin",
                "phase": phase,
                "state": "finished",
                "elapsed_ms": elapsed_ms,
            },
        )


def _relay_team_progress(
    callback: Callable[[dict[str, object]], None],
    value: dict[str, object],
) -> None:
    event = progress_contract.canonical_event(value)
    event.pop("seq")
    _progress(callback, {"origin": "team", **event})


def _immutable(*_args, **_kwargs):
    raise TypeError("public chat projections are immutable")


class FrozenDict(dict):
    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = _immutable


class FrozenList(list):
    __setitem__ = __delitem__ = __iadd__ = __imul__ = _immutable
    append = clear = extend = insert = pop = remove = reverse = sort = _immutable


def _freeze(value: object) -> object:
    if isinstance(value, dict):
        return FrozenDict((key, _freeze(item)) for key, item in value.items())
    if isinstance(value, list):
        return FrozenList(_freeze(item) for item in value)
    return value


@dataclass(frozen=True, eq=False)
class PublicResponse(team.TeamResponse):
    """A fully projected response whose nested public payload cannot be mutated."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "body", _freeze(self.body))

    def __eq__(self, other: object) -> bool:
        return isinstance(other, team.TeamResponse) and self.status == other.status and self.body == other.body

    def websocket_event(self, team_id: str) -> dict[str, object] | None:
        body = self.body
        challenge_status = body.get("status")
        if challenge_status == "integrations-required":
            if body.get("team_id") != team_id:
                return None
            event = {"type": challenge_status, **body}
            event.pop("team_id", None)
            event.pop("status", None)
            event.pop("turn_id", None)
            return event
        if not 200 <= self.status < 300:
            status = self.status if 400 <= self.status <= 599 else 502
            code = body.get("code")
            detail = _CHAT_ERROR_DETAILS.get(code) if isinstance(code, str) else None
            return {
                "type": "error",
                "status": status,
                "detail": (
                    f"{code}: {detail}"
                    if detail is not None
                    else _CHAT_ERROR_FALLBACKS.get(status, "local chat request failed")
                ),
            }
        if body.get("team_id") != team_id:
            return None
        event = None
        if set(body) == {"team_id", "team_name", "reply"}:
            event = {"type": "done", **body}
        return event


def _unavailable() -> team.TeamResponse:
    return PublicResponse(
        HTTPStatus.SERVICE_UNAVAILABLE,
        {"code": "runtime-unavailable"},
    )


def _safe_error(response: team.TeamResponse) -> team.TeamResponse:
    """Reduce one authenticated controller failure to a bounded, non-secret machine code."""
    code = response.body.get("code")
    if not isinstance(code, str) or len(code) > 80 or _ERROR_CODE_RE.fullmatch(code) is None:
        code = "chat-request-failed"
    return PublicResponse(response.status, {"code": code})


def _inference(team_id: str) -> tuple[str, str] | team.TeamResponse:
    response = team.get_inference(team_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    provider = response.body.get("provider")
    model = response.body.get("model")
    try:
        selected_provider = models.canonical_provider(provider)
        selected_model = models.canonical_model(selected_provider, model)
    except models.ModelProviderError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    if provider != selected_provider:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    return selected_provider, selected_model


def _model_credential(team_id: str) -> tuple[str, str] | team.TeamResponse:
    inference = _inference(team_id)
    if isinstance(inference, team.TeamResponse):
        return inference
    provider, _model = inference
    try:
        api_key = models.resolve_api_key(provider)
    except models.ModelProviderError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "model-credential-store-invalid"})
    if api_key is None:
        return PublicResponse(HTTPStatus.CONFLICT, {"code": "model-credential-missing"})
    return provider, api_key


def _challenge_envelope(
    response: team.TeamResponse,
    team_id: str,
    status: str,
    fields: frozenset[str],
) -> tuple[str, str]:
    if set(response.body) != fields:
        raise ValueError("invalid challenge envelope")
    if (
        response.body["team_id"] != team_id
        or response.body["status"] != status
        or not _valid_trace_id(response.body["trace_id"])
    ):
        raise ValueError("invalid challenge identity")
    identity = chat_ws_common.challenge_identity(response.body, team_id)
    if identity is None:
        raise ValueError("invalid challenge metadata")
    return identity


def _project_integration_challenge(response: team.TeamResponse, team_id: str) -> team.TeamResponse:
    """Project an OAuth consent gate without exposing any authorization material."""
    try:
        challenge_id, turn_id = _challenge_envelope(
            response,
            team_id,
            "integrations-required",
            _INTEGRATION_CHALLENGE_RESPONSE_FIELDS,
        )
        expires_in = response.body["expires_in"]
        raw_requirements = response.body["requirements"]
        if (
            not isinstance(expires_in, int)
            or isinstance(expires_in, bool)
            or not 1 <= expires_in <= 900
            or not isinstance(raw_requirements, list)
            or not 1 <= len(raw_requirements) <= MAX_INTEGRATION_REQUIREMENTS
        ):
            raise ValueError("invalid integration metadata")

        requirements: list[dict[str, object]] = []
        seen_integrations: set[tuple[str, str]] = set()
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "integration_id",
                "provider",
                "name",
                "summary",
                "scopes",
                "powers",
            }:
                raise ValueError("invalid integration requirement")
            assistant_id = team.canonical_assistant_id(raw["assistant_id"])
            integration_id = team.canonical_assistant_id(raw["integration_id"])
            identity = (assistant_id, integration_id)
            if identity in seen_integrations:
                raise ValueError("duplicate integration")
            seen_integrations.add(identity)

            raw_scopes = raw["scopes"]
            raw_powers = raw["powers"]
            if (
                not isinstance(raw_scopes, list)
                or not 1 <= len(raw_scopes) <= MAX_INTEGRATION_SCOPES
                or not isinstance(raw_powers, list)
                or not 1 <= len(raw_powers) <= MAX_INTEGRATION_POWERS
            ):
                raise ValueError("invalid integration capabilities")
            scopes = [chat_ws_common.public_text(scope, MAX_INTEGRATION_SCOPE_CHARS) for scope in raw_scopes]
            if len(set(scopes)) != len(scopes):
                raise ValueError("duplicate integration scope")

            powers: list[dict[str, str]] = []
            seen_powers: set[str] = set()
            for raw_power in raw_powers:
                if not isinstance(raw_power, dict) or set(raw_power) != {"id", "name", "summary"}:
                    raise ValueError("invalid integration Power")
                power_id = team.canonical_assistant_id(raw_power["id"])
                if power_id in seen_powers:
                    raise ValueError("duplicate integration Power")
                seen_powers.add(power_id)
                powers.append(
                    {
                        "id": power_id,
                        "name": chat_ws_common.public_text(raw_power["name"], MAX_INTEGRATION_LABEL_CHARS),
                        "summary": chat_ws_common.public_text(raw_power["summary"], MAX_INTEGRATION_SUMMARY_CHARS),
                    }
                )
            requirements.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": chat_ws_common.public_text(raw["assistant_name"], MAX_INTEGRATION_LABEL_CHARS),
                    "integration_id": integration_id,
                    "provider": team.canonical_assistant_id(raw["provider"]),
                    "name": chat_ws_common.public_text(raw["name"], MAX_INTEGRATION_LABEL_CHARS),
                    "summary": chat_ws_common.public_text(raw["summary"], MAX_INTEGRATION_SUMMARY_CHARS),
                    "scopes": scopes,
                    "powers": powers,
                }
            )
    except KeyError, TypeError, ValueError, team.TeamRequestError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "integration-challenge-response-invalid"})
    return PublicResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "integrations-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "expires_in": expires_in,
            "requirements": requirements,
        },
    )


def _project_pending_challenge(response: team.TeamResponse, team_id: str) -> team.TeamResponse:
    if response.body.get("status") == "integrations-required":
        return _project_integration_challenge(response, team_id)
    return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-challenge-response-invalid"})


def _project_turn(
    response: team.TeamResponse,
    team_id: str,
    *,
    forbidden_values: tuple[str, ...],
) -> team.TeamResponse:
    response_team_id = response.body.get("team_id")
    team_name = response.body.get("team_name")
    reply = response.body.get("reply")
    if (
        set(response.body) != _TURN_RESPONSE_FIELDS
        or response_team_id != team_id
        or not _valid_trace_id(response.body.get("trace_id"))
        or not _valid_team_name(team_name)
        or not isinstance(reply, str)
        or not reply.strip()
        or len(reply) > MAX_REPLY_CHARS
        or _REPLY_CONTROL_RE.search(reply) is not None
        or any(value and (value in team_name or value in reply) for value in forbidden_values)
    ):
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-response-invalid"})
    return PublicResponse(
        response.status,
        {"team_id": team_id, "team_name": team_name, "reply": reply},
    )


def _submit(
    team_id: object,
    payload: object,
    canonicalize: Callable[[object], dict[str, object]],
    request: Callable[..., team.TeamResponse],
    progress: Callable[[dict[str, object]], None],
) -> team.TeamResponse:
    with _admin_span(progress, "admin-preparation"):
        canonical_id = team.canonical_team_id(team_id)
        body = canonicalize(payload)
        credential = _model_credential(canonical_id)
    if isinstance(credential, team.TeamResponse):
        return credential
    provider, api_key = credential

    response = request(
        canonical_id,
        body,
        provider=provider,
        api_key=api_key,
        progress=lambda event: _relay_team_progress(progress, event),
    )
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_pending_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)

    with _admin_span(progress, "reply-validation"):
        return _project_turn(response, canonical_id, forbidden_values=(api_key,))


def turn(
    team_id: object,
    payload: object,
    progress: Callable[[dict[str, object]], None] = _ignore_progress,
) -> team.TeamResponse:
    return _submit(team_id, payload, team.canonical_chat_payload, team.chat, progress)


def resume_integrations(
    team_id: object,
    challenge_id: object,
    progress: Callable[[dict[str, object]], None] = _ignore_progress,
) -> team.TeamResponse:
    return _submit(
        team_id,
        {"challenge_id": challenge_id},
        team.canonical_integration_resume,
        team.resume_chat_integrations,
        progress,
    )


def _pending(
    team_id: object,
    request: Callable[[str], team.TeamResponse],
    project: Callable[[team.TeamResponse, str], team.TeamResponse],
    invalid_code: str,
) -> team.TeamResponse:
    canonical_id = team.canonical_team_id(team_id)
    response = request(canonical_id)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if not 200 <= response.status < 300:
        return _safe_error(response)
    if set(response.body) != {"team_id", "status", "trace_id"}:
        return project(response, canonical_id)
    if (
        response.body.get("team_id") == canonical_id
        and response.body.get("status") == "none"
        and _valid_trace_id(response.body.get("trace_id"))
    ):
        return PublicResponse(response.status, {"team_id": canonical_id, "status": "none"})
    return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": invalid_code})


def pending_integrations(team_id: object) -> team.TeamResponse:
    return _pending(
        team_id,
        team.pending_chat_integrations,
        _project_integration_challenge,
        "integration-challenge-response-invalid",
    )


def _valid_team_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= MAX_TEAM_NAME_CHARS
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _valid_trace_id(value: object) -> bool:
    return isinstance(value, str) and chat_ws_common.HEX_ID_RE.fullmatch(value) is not None


def stop(team_id: object) -> team.TeamResponse:
    canonical_id = team.canonical_team_id(team_id)
    response = team.stop_chat(canonical_id)
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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-stop-response-invalid"})
    # ``accepted`` means the active turn token was cancelled and any late provider reply will be
    # discarded. ``confirmed`` describes only a Power subprocess, not the whole turn.
    return PublicResponse(response.status, {"team_id": canonical_id, "stopped": accepted})
