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
from collections.abc import Callable
from dataclasses import dataclass
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
_INPUT_CHALLENGE_RESPONSE_FIELDS = frozenset({"team_id", "status", "turn_id", "challenge_id", "request", "trace_id"})
_ACCOUNT_CHALLENGE_RESPONSE_FIELDS = frozenset(
    {"team_id", "status", "turn_id", "challenge_id", "expires_in", "requirements", "trace_id"}
)
_INVENTORY_RESPONSE_FIELDS = frozenset({"team_id", "assistants", "trace_id"})
_CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_SECRET_REQUIREMENTS = 16
MAX_SECRETS_PER_CHALLENGE = 64
MAX_SECRET_LABEL_CHARS = 80
MAX_SECRET_SUMMARY_CHARS = 160
MAX_INSTALLED_ASSISTANTS = 128
MAX_ACCOUNT_REQUIREMENTS = 64
MAX_ACCOUNT_SCOPES = 32
MAX_ACCOUNT_POWERS = 128
MAX_ACCOUNT_SCOPE_CHARS = 128
MAX_REMEMBERED_APPROVALS = 8192
INPUT_TYPES = frozenset({"str", "int", "float", "bool", "choice", "choices"})
MAX_INPUT_OPTIONS = 64
MAX_INPUT_OPTION_CHARS = 200
_CHAT_ERROR_DETAILS = {
    "assistant-power-blocked": "Assistant Power execution is blocked until it is reinstalled",
    "assistant-approval-challenge-expired": "the Assistant approval expired; retry the message",
    "assistant-approval-state-unavailable": "remembered Assistant approvals are unavailable",
    "assistant-input-challenge-expired": "the Assistant input request expired; retry the message",
    "assistant-input-replay-changed": "the Assistant input flow changed; retry the message",
    "assistant-account-challenge-expired": "the Assistant account expired; retry the message",
    "assistant-account-contract-invalid": "the Assistant account contract changed; retry the message",
    "assistant-account-state-unavailable": "Assistant account state is unavailable",
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
    "secret-challenge-response-invalid": "the Assistant secret challenge was invalid",
    "secret-inventory-response-invalid": "the Assistant secret inventory was invalid",
    "approval-challenge-response-invalid": "the Assistant approval challenge was invalid",
    "approval-inventory-response-invalid": "the remembered Assistant approvals were invalid",
    "account-challenge-response-invalid": "the Assistant account challenge was invalid",
    "input-challenge-response-invalid": "the Assistant input challenge was invalid",
    "team-context-changed": "the Team capabilities changed; retry",
    "team-has-no-active-assistants": "install and start at least one Assistant before chatting",
}
_CHAT_ERROR_FALLBACKS = {
    400: "invalid chat request",
    409: "chat turn could not start",
    429: "local chat capacity reached",
    503: "local chat runtime is unavailable",
}


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
class PublicResponse(teams.DriverResponse):
    """A fully projected response whose nested public payload cannot be mutated."""

    def __post_init__(self) -> None:
        object.__setattr__(self, "body", _freeze(self.body))

    def __eq__(self, other: object) -> bool:
        return isinstance(other, teams.DriverResponse) and self.status == other.status and self.body == other.body

    def websocket_event(self, team_id: str) -> dict[str, object] | None:
        body = self.body
        challenge_status = body.get("status")
        if challenge_status in {"secrets-required", "approval-required", "accounts-required", "input-required"}:
            if body.get("team_id") != team_id:
                return None
            event = {"type": challenge_status, **body}
            event.pop("team_id", None)
            event.pop("status", None)
            if challenge_status == "accounts-required":
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
        if set(body) == {"team_id", "team_name", "reply"}:
            return {"type": "done", **body}
        if set(body) == {"team_id", "assistants"}:
            return {"type": "secret-inventory", **body}
        return None


def _unavailable() -> teams.DriverResponse:
    return PublicResponse(
        HTTPStatus.SERVICE_UNAVAILABLE,
        {"code": "runtime-unavailable"},
    )


def _safe_error(response: teams.DriverResponse) -> teams.DriverResponse:
    """Reduce one authenticated controller failure to a bounded, non-secret machine code."""
    code = response.body.get("code")
    if not isinstance(code, str) or len(code) > 80 or _ERROR_CODE_RE.fullmatch(code) is None:
        code = "chat-request-failed"
    return PublicResponse(response.status, {"code": code})


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    if provider != selected_provider:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "inference-response-invalid"})
    return selected_provider, selected_model


def _model_credential(team_id: str) -> tuple[str, str] | teams.DriverResponse:
    inference = _inference(team_id)
    if isinstance(inference, teams.DriverResponse):
        return inference
    provider, _model = inference
    try:
        api_key = modelproviders.resolve_api_key(provider)
    except modelproviders.ModelProviderError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "model-credential-store-invalid"})
    if api_key is None:
        return PublicResponse(HTTPStatus.CONFLICT, {"code": "model-credential-missing"})
    return provider, api_key


def _clean_public_text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or not value.isprintable()
    ):
        raise ValueError("invalid public text")
    return value


def _challenge_envelope(
    response: teams.DriverResponse,
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
    challenge_id = response.body["challenge_id"]
    turn_id = response.body["turn_id"]
    if (
        not isinstance(challenge_id, str)
        or _CHALLENGE_ID_RE.fullmatch(challenge_id) is None
        or not isinstance(turn_id, str)
        or _CHALLENGE_ID_RE.fullmatch(turn_id) is None
    ):
        raise ValueError("invalid challenge metadata")
    return challenge_id, turn_id


def _project_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    try:
        challenge_id, turn_id = _challenge_envelope(
            response,
            team_id,
            "secrets-required",
            _CHALLENGE_RESPONSE_FIELDS,
        )
        raw_requirements = response.body["requirements"]
        if not isinstance(raw_requirements, list) or not 1 <= len(raw_requirements) <= MAX_SECRET_REQUIREMENTS:
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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "secret-challenge-response-invalid"})
    return PublicResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "secrets-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "requirements": requirements,
        },
    )


def _project_approval_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    try:
        challenge_id, turn_id = _challenge_envelope(
            response,
            team_id,
            "approval-required",
            _CHALLENGE_RESPONSE_FIELDS,
        )
        raw_requirements = response.body["requirements"]
        if not isinstance(raw_requirements, list) or len(raw_requirements) != 1:
            raise ValueError("invalid approval metadata")
        requirements: list[dict[str, object]] = []
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "power_id",
                "title",
                "summary",
                "docs",
                "approval",
            }:
                raise ValueError("invalid approval requirement")
            assistant_id = teams.canonical_assistant_id(raw["assistant_id"])
            power_id = teams.canonical_assistant_id(raw["power_id"])
            if raw["approval"] not in {"always", "once"}:
                raise ValueError("invalid approval policy")
            docs = raw["docs"]
            if docs is not None:
                docs = _clean_public_text(docs, 2048)
            requirements.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": _clean_public_text(raw["assistant_name"], MAX_SECRET_LABEL_CHARS),
                    "power_id": power_id,
                    "title": _clean_public_text(raw["title"], MAX_SECRET_LABEL_CHARS),
                    "summary": _clean_public_text(raw["summary"], 240),
                    "docs": docs,
                    "approval": raw["approval"],
                }
            )
    except KeyError, TypeError, ValueError, UnicodeError, teams.TeamRequestError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-challenge-response-invalid"})
    return PublicResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "approval-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "requirements": requirements,
        },
    )


def _project_input_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    try:
        challenge_id, turn_id = _challenge_envelope(
            response,
            team_id,
            "input-required",
            _INPUT_CHALLENGE_RESPONSE_FIELDS,
        )
        request = response.body["request"]
        if not isinstance(request, dict) or set(request) != {"type", "title", "summary", "docs", "options"}:
            raise ValueError("invalid input metadata")
        request_type = request["type"]
        options = request["options"]
        if (
            not isinstance(request_type, str)
            or request_type not in INPUT_TYPES
            or not isinstance(options, list)
            or len(options) > MAX_INPUT_OPTIONS
        ):
            raise ValueError("invalid input request")
        if request_type in {"choice", "choices"}:
            if (
                not options
                or any(
                    not isinstance(option, str) or not option or len(option) > MAX_INPUT_OPTION_CHARS or "\0" in option
                    for option in options
                )
                or len(options) != len(set(options))
            ):
                raise ValueError("invalid input options")
        elif options:
            raise ValueError("invalid primitive input options")
        docs = request["docs"]
        if docs is not None:
            docs = _clean_public_text(docs, 2048)
        projected = {
            "type": request_type,
            "title": _clean_public_text(request["title"], 80),
            "summary": _clean_public_text(request["summary"], 240),
            "docs": docs,
            "options": list(options),
        }
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "input-challenge-response-invalid"})
    return PublicResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "input-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "request": projected,
        },
    )


def _project_account_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    """Project an OAuth consent gate without exposing any authorization material."""
    try:
        challenge_id, turn_id = _challenge_envelope(
            response,
            team_id,
            "accounts-required",
            _ACCOUNT_CHALLENGE_RESPONSE_FIELDS,
        )
        expires_in = response.body["expires_in"]
        raw_requirements = response.body["requirements"]
        if (
            not isinstance(expires_in, int)
            or isinstance(expires_in, bool)
            or not 1 <= expires_in <= 900
            or not isinstance(raw_requirements, list)
            or not 1 <= len(raw_requirements) <= MAX_ACCOUNT_REQUIREMENTS
        ):
            raise ValueError("invalid account metadata")

        requirements: list[dict[str, object]] = []
        seen_accounts: set[tuple[str, str]] = set()
        for raw in raw_requirements:
            if not isinstance(raw, dict) or set(raw) != {
                "assistant_id",
                "assistant_name",
                "account_id",
                "provider",
                "name",
                "summary",
                "scopes",
                "powers",
            }:
                raise ValueError("invalid account requirement")
            assistant_id = teams.canonical_assistant_id(raw["assistant_id"])
            account_id = teams.canonical_assistant_id(raw["account_id"])
            identity = (assistant_id, account_id)
            if identity in seen_accounts:
                raise ValueError("duplicate account")
            seen_accounts.add(identity)

            raw_scopes = raw["scopes"]
            raw_powers = raw["powers"]
            if (
                not isinstance(raw_scopes, list)
                or not 1 <= len(raw_scopes) <= MAX_ACCOUNT_SCOPES
                or not isinstance(raw_powers, list)
                or not 1 <= len(raw_powers) <= MAX_ACCOUNT_POWERS
            ):
                raise ValueError("invalid account capabilities")
            scopes = [_clean_public_text(scope, MAX_ACCOUNT_SCOPE_CHARS) for scope in raw_scopes]
            if len(set(scopes)) != len(scopes):
                raise ValueError("duplicate account scope")

            powers: list[dict[str, str]] = []
            seen_powers: set[str] = set()
            for raw_power in raw_powers:
                if not isinstance(raw_power, dict) or set(raw_power) != {"id", "name", "summary"}:
                    raise ValueError("invalid account Power")
                power_id = teams.canonical_assistant_id(raw_power["id"])
                if power_id in seen_powers:
                    raise ValueError("duplicate account Power")
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
                    "account_id": account_id,
                    "provider": teams.canonical_assistant_id(raw["provider"]),
                    "name": _clean_public_text(raw["name"], MAX_SECRET_LABEL_CHARS),
                    "summary": _clean_public_text(raw["summary"], MAX_SECRET_SUMMARY_CHARS),
                    "scopes": scopes,
                    "powers": powers,
                }
            )
    except KeyError, TypeError, ValueError, teams.TeamRequestError:
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "account-challenge-response-invalid"})
    return PublicResponse(
        response.status,
        {
            "team_id": team_id,
            "status": "accounts-required",
            "turn_id": turn_id,
            "challenge_id": challenge_id,
            "expires_in": expires_in,
            "requirements": requirements,
        },
    )


def _project_pending_challenge(response: teams.DriverResponse, team_id: str) -> teams.DriverResponse:
    status = response.body.get("status")
    if status == "accounts-required":
        return _project_account_challenge(response, team_id)
    if status == "secrets-required":
        return _project_challenge(response, team_id)
    if status == "approval-required":
        return _project_approval_challenge(response, team_id)
    if status == "input-required":
        return _project_input_challenge(response, team_id)
    return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-challenge-response-invalid"})


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "secret-inventory-response-invalid"})
    return PublicResponse(response.status, {"team_id": team_id, "assistants": assistants})


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-response-invalid"})
    return PublicResponse(
        response.status,
        {"team_id": team_id, "team_name": team_name, "reply": reply},
    )


def _submit(
    team_id: object,
    payload: object,
    canonicalize: Callable[[object], dict[str, object]],
    request: Callable[..., teams.DriverResponse],
    forbidden_values: Callable[[dict[str, object]], tuple[str, ...]] = lambda _body: (),
) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
    body = canonicalize(payload)
    credential = _model_credential(canonical_id)
    if isinstance(credential, teams.DriverResponse):
        return credential
    provider, api_key = credential

    response = request(canonical_id, body, provider=provider, api_key=api_key)
    if response.status in _MISSING_RUNTIME_STATUSES:
        return _unavailable()
    if response.status == HTTPStatus.PRECONDITION_REQUIRED:
        return _project_pending_challenge(response, canonical_id)
    if not 200 <= response.status < 300:
        return _safe_error(response)

    return _project_turn(response, canonical_id, forbidden_values=(api_key, *forbidden_values(body)))


def _secret_values(body: dict[str, object]) -> tuple[str, ...]:
    return tuple(item["value"] for item in body["values"])


def _input_values(body: dict[str, object]) -> tuple[str, ...]:
    answer = body["answer"]
    return (answer,) if isinstance(answer, str) else ()


def turn(team_id: object, payload: object) -> teams.DriverResponse:
    return _submit(team_id, payload, teams.canonical_chat_payload, teams.chat)


def submit_secrets(team_id: object, payload: object) -> teams.DriverResponse:
    return _submit(
        team_id,
        payload,
        teams.canonical_secret_submission,
        teams.submit_chat_secrets,
        _secret_values,
    )


def resume_accounts(team_id: object, challenge_id: object) -> teams.DriverResponse:
    return _submit(
        team_id,
        {"challenge_id": challenge_id},
        teams.canonical_account_resume,
        teams.resume_chat_accounts,
    )


def submit_approval(team_id: object, payload: object) -> teams.DriverResponse:
    return _submit(
        team_id,
        payload,
        teams.canonical_approval_submission,
        teams.submit_chat_approval,
    )


def submit_input(team_id: object, payload: object) -> teams.DriverResponse:
    return _submit(
        team_id,
        payload,
        teams.canonical_input_submission,
        teams.submit_chat_input,
        _input_values,
    )


def _pending(
    team_id: object,
    request: Callable[[str], teams.DriverResponse],
    project: Callable[[teams.DriverResponse, str], teams.DriverResponse],
    invalid_code: str,
) -> teams.DriverResponse:
    canonical_id = teams.canonical_team_id(team_id)
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


def pending_secrets(team_id: object) -> teams.DriverResponse:
    return _pending(
        team_id,
        teams.pending_chat_secrets,
        _project_challenge,
        "secret-challenge-response-invalid",
    )


def pending_accounts(team_id: object) -> teams.DriverResponse:
    return _pending(
        team_id,
        teams.pending_chat_accounts,
        _project_account_challenge,
        "account-challenge-response-invalid",
    )


def pending_approval(team_id: object) -> teams.DriverResponse:
    return _pending(
        team_id,
        teams.pending_chat_approval,
        _project_approval_challenge,
        "approval-challenge-response-invalid",
    )


def pending_input(team_id: object) -> teams.DriverResponse:
    return _pending(
        team_id,
        teams.pending_chat_input,
        _project_input_challenge,
        "input-challenge-response-invalid",
    )


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-inventory-response-invalid"})
    return PublicResponse(response.status, {"team_id": canonical_id, "grants": grants})


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "approval-inventory-response-invalid"})
    return PublicResponse(response.status, {"team_id": canonical_id, "revoked": revoked})


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
        return PublicResponse(HTTPStatus.BAD_GATEWAY, {"code": "chat-stop-response-invalid"})
    # ``accepted`` means the active turn token was cancelled and any late provider reply will be
    # discarded. ``confirmed`` describes only a Power subprocess, not the whole turn.
    return PublicResponse(response.status, {"team_id": canonical_id, "stopped": accepted})
