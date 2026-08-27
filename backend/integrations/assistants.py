"""OAuth integration projection and fixed Cloudflare authorization bridge."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from urllib.parse import parse_qsl, urlparse

from team import transport

from chat import payloads
from integrations import cloudflare
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

log = logging.getLogger("shimpz-admin")

TeamResponse = transport.TeamResponse
TeamRequestError = transport.TeamRequestError

MAX_ASSISTANT_INTEGRATIONS = 512
MAX_INTEGRATION_SCOPES = 32

_OAUTH_BINDING_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_OAUTH_CLAIM_RE = re.compile(r"^[0-9a-f]{64}$")
_OAUTH_SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
_SEMANTIC_VERSION_RE = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")


def _canonical_team_id(value: object) -> str:
    canonical = team_contract.canonical_team_id(value)
    if canonical is None:
        raise TeamRequestError("team id must be a canonical lowercase identifier")
    return canonical


def canonical_oauth_binding(value: object) -> str:
    if not isinstance(value, str) or _OAUTH_BINDING_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth browser binding is invalid")
    return value


def canonical_oauth_claim(value: object) -> str:
    if not isinstance(value, str) or _OAUTH_CLAIM_RE.fullmatch(value) is None:
        raise TeamRequestError("OAuth authorization response is invalid")
    return value


def _integration_scopes(value: object) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_INTEGRATION_SCOPES:
        raise ValueError("invalid OAuth scopes")
    scopes: list[str] = []
    for item in value:
        if not isinstance(item, str) or _OAUTH_SCOPE_RE.fullmatch(item) is None:
            raise ValueError("invalid OAuth scopes")
        scopes.append(item)
    if len(set(scopes)) != len(scopes):
        raise ValueError("duplicate OAuth scopes")
    return scopes


def _integration_identity(value: object) -> dict[str, str | None] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"id", "name", "username"}:
        raise ValueError("invalid OAuth integration")
    integration_id = chat_ws_common.public_text(value["id"], 128, field="OAuth integration id")
    result: dict[str, str | None] = {"id": integration_id, "name": None, "username": None}
    for field in ("name", "username"):
        item = value[field]
        if item is not None:
            result[field] = chat_ws_common.public_text(item, 128, field=f"OAuth integration {field}")
    return result


def _integration_expiry(value: object) -> str | None:
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


def _project_integration_inventory(response: TeamResponse, team_id: str) -> TeamResponse:
    """Expose status metadata only; provider tokens and controller generations stay private."""
    if not 200 <= response.status < 300:
        return response
    try:
        if (
            set(response.body) != {"team_id", "integrations", "trace_id"}
            or response.body["team_id"] != team_id
            or not isinstance(response.body["trace_id"], str)
            or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
        ):
            raise ValueError("invalid Team integration envelope")
        raw_integrations = response.body["integrations"]
        if not isinstance(raw_integrations, list) or len(raw_integrations) > MAX_ASSISTANT_INTEGRATIONS:
            raise ValueError("invalid Team integration inventory")
        integrations: list[dict[str, object]] = []
        identities: set[tuple[str, str]] = set()
        for item in raw_integrations:
            if not isinstance(item, dict) or set(item) != {
                "assistant_id",
                "assistant_name",
                "assistant_version",
                "assistant_summary",
                "id",
                "provider",
                "name",
                "summary",
                "scopes",
                "status",
                "integration",
                "expires_at",
            }:
                raise ValueError("invalid Team integration fields")
            assistant_id = payloads.canonical_assistant_id(item["assistant_id"])
            integration_id = payloads.canonical_assistant_id(item["id"])
            identity = (assistant_id, integration_id)
            if identity in identities:
                raise ValueError("duplicate Team integration")
            identities.add(identity)
            assistant_version = item["assistant_version"]
            if not isinstance(assistant_version, str) or _SEMANTIC_VERSION_RE.fullmatch(assistant_version) is None:
                raise ValueError("invalid Assistant version")
            status = item["status"]
            if status not in {"missing", "connected", "expired", "reauthorization-required"}:
                raise ValueError("invalid Team integration status")
            integrations.append(
                {
                    "assistant_id": assistant_id,
                    "assistant_name": chat_ws_common.public_text(item["assistant_name"], 80, field="Assistant name"),
                    "assistant_version": assistant_version,
                    "assistant_summary": chat_ws_common.public_text(
                        item["assistant_summary"], 160, field="Assistant summary"
                    ),
                    "id": integration_id,
                    "provider": payloads.canonical_assistant_id(item["provider"]),
                    "name": chat_ws_common.public_text(item["name"], 80, field="integration name"),
                    "summary": chat_ws_common.public_text(item["summary"], 160, field="integration summary"),
                    "scopes": _integration_scopes(item["scopes"]),
                    "status": status,
                    "integration": _integration_identity(item["integration"]),
                    "expires_at": _integration_expiry(item["expires_at"]),
                }
            )
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team returned an invalid Assistant integration inventory")
        return TeamResponse(502, {"detail": "Assistant integration inventory is invalid."})
    return TeamResponse(200, {"integrations": integrations})


def list_assistant_integrations(team_id: object) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    return _project_integration_inventory(
        transport._call("GET", f"/v1/teams/{canonical_id}/assistant-integrations"),
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
    cloudflare.canonical_authorization_scopes(fields["scope"])
    return value


def _project_authorization_response(response: TeamResponse, callback_mode: str) -> TeamResponse:
    if not 200 <= response.status < 300:
        return response
    try:
        if (
            set(response.body) != {"authorization_url", "trace_id"}
            or not isinstance(response.body["trace_id"], str)
            or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
        ):
            raise ValueError("invalid OAuth authorization response")
        authorization_url = _trusted_cloudflare_authorization_url(response.body["authorization_url"], callback_mode)
    except KeyError, TypeError, ValueError:
        log.warning("team returned an invalid OAuth authorization response")
        return TeamResponse(502, {"detail": "OAuth authorization response is invalid."})
    return TeamResponse(200, {"authorization_url": authorization_url})


def start_local_assistant_integration_authorization(
    team_id: object,
    challenge_id: object,
    assistant_id: object,
    integration_id: object,
    session_binding: object,
    callback_mode: object,
) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    canonical_challenge = payloads.canonical_challenge_id(challenge_id)
    assistant = payloads.canonical_assistant_id(assistant_id)
    integration = payloads.canonical_assistant_id(integration_id)
    binding = canonical_oauth_binding(session_binding)
    if callback_mode not in {"loopback", "hosted", "out-of-band"}:
        raise TeamRequestError("OAuth callback mode is invalid.")
    response = transport._call(
        "POST",
        f"/v1/teams/{canonical_id}/assistant-integrations/challenges/{canonical_challenge}/authorize",
        {
            "assistant_id": assistant,
            "integration_id": integration,
            "callback_mode": callback_mode,
            "session_binding": binding,
        },
    )
    return _project_authorization_response(response, callback_mode)


def cancel_local_assistant_integration_authorization(
    team_id: object,
    challenge_id: object,
    session_binding: object,
) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    canonical_challenge = payloads.canonical_challenge_id(challenge_id)
    binding = canonical_oauth_binding(session_binding)
    response = transport._call(
        "DELETE",
        f"/v1/teams/{canonical_id}/assistant-integrations/challenges/{canonical_challenge}/authorize",
        {"session_binding": binding},
    )
    if not 200 <= response.status < 300:
        return response
    if (
        response.status != 200
        or set(response.body) != {"cancelled", "trace_id"}
        or type(response.body["cancelled"]) is not bool
        or not isinstance(response.body["trace_id"], str)
        or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
    ):
        log.warning("team returned an invalid OAuth cancellation response")
        return TeamResponse(502, {"detail": "OAuth cancellation response is invalid."})
    return TeamResponse(204, {})


def disconnect_assistant_integration(
    team_id: object,
    assistant_id: object,
    integration_id: object,
) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    assistant = payloads.canonical_assistant_id(assistant_id)
    integration = payloads.canonical_assistant_id(integration_id)
    response = transport._call(
        "DELETE",
        f"/v1/teams/{canonical_id}/assistant-integrations/{assistant}/{integration}",
    )
    if not 200 <= response.status < 300:
        return response
    if (
        response.status != 200
        or set(response.body) != {"disconnected", "trace_id"}
        or type(response.body["disconnected"]) is not bool
        or not isinstance(response.body["trace_id"], str)
        or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
    ):
        log.warning("team returned an invalid OAuth disconnect response")
        return TeamResponse(502, {"detail": "OAuth disconnect response is invalid."})
    return TeamResponse(204, {})


def complete_cloudflare_oauth_callback(*, state: object, claim: object, session_binding: object) -> TeamResponse:
    identifier = canonical_oauth_binding(state)
    one_time_claim = canonical_oauth_claim(claim)
    binding = canonical_oauth_binding(session_binding)
    response = transport._call(
        "POST",
        "/v1/oauth/cloudflare/callback",
        {"state": identifier, "claim": one_time_claim, "session_binding": binding},
    )
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"connected", "team_id", "assistant_id", "integration_id", "trace_id"}:
            raise ValueError("invalid OAuth callback response")
        if (
            response.body["connected"] is not True
            or not isinstance(response.body["trace_id"], str)
            or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
        ):
            raise ValueError("invalid OAuth callback response")
        body = {
            "connected": True,
            "team_id": _canonical_team_id(response.body["team_id"]),
            "assistant_id": payloads.canonical_assistant_id(response.body["assistant_id"]),
            "integration_id": payloads.canonical_assistant_id(response.body["integration_id"]),
        }
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team returned an invalid OAuth callback response")
        return TeamResponse(502, {"detail": "OAuth callback response is invalid."})
    return TeamResponse(200, body)
