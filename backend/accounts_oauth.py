"""OAuth account projection and fixed Cloudflare authorization bridge."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from urllib.parse import parse_qsl, urlparse

import chat_payloads
import chat_ws_common
import team_client
import team_contract

log = logging.getLogger("shimpz-admin")

TeamResponse = team_client.TeamResponse
TeamRequestError = team_client.TeamRequestError

MAX_ASSISTANT_ACCOUNTS = 512
MAX_ACCOUNT_SCOPES = 32

_OAUTH_BINDING_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_OAUTH_CLAIM_RE = re.compile(r"^[0-9a-f]{64}$")
_OAUTH_SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
_CLOUDFLARE_SCOPES = ("dns.read", "offline_access", "zone.read")


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
    account_id = chat_ws_common.public_text(value["id"], 128, field="OAuth account id")
    result: dict[str, str | None] = {"id": account_id, "name": None, "username": None}
    for field in ("name", "username"):
        item = value[field]
        if item is not None:
            result[field] = chat_ws_common.public_text(item, 128, field=f"OAuth account {field}")
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


def _project_account_inventory(response: TeamResponse, team_id: str) -> TeamResponse:
    """Expose status metadata only; provider tokens and controller generations stay private."""
    if not 200 <= response.status < 300:
        return response
    try:
        if (
            set(response.body) != {"team_id", "accounts", "trace_id"}
            or response.body["team_id"] != team_id
            or not isinstance(response.body["trace_id"], str)
            or chat_ws_common.HEX_ID_RE.fullmatch(response.body["trace_id"]) is None
        ):
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
            assistant_id = chat_payloads.canonical_assistant_id(item["assistant_id"])
            account_id = chat_payloads.canonical_assistant_id(item["id"])
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
                    "assistant_name": chat_ws_common.public_text(item["assistant_name"], 80, field="Assistant name"),
                    "id": account_id,
                    "provider": chat_payloads.canonical_assistant_id(item["provider"]),
                    "name": chat_ws_common.public_text(item["name"], 80, field="account name"),
                    "summary": chat_ws_common.public_text(item["summary"], 160, field="account summary"),
                    "scopes": _account_scopes(item["scopes"]),
                    "status": status,
                    "account": _account_identity(item["account"]),
                    "expires_at": _account_expiry(item["expires_at"]),
                }
            )
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team returned an invalid Assistant account inventory")
        return TeamResponse(502, {"detail": "Assistant account inventory is invalid."})
    return TeamResponse(200, {"accounts": accounts})


def list_assistant_accounts(team_id: object) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    return _project_account_inventory(
        team_client._call("GET", f"/v1/teams/{canonical_id}/assistant-accounts"),
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
) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    canonical_challenge = chat_payloads.canonical_challenge_id(challenge_id)
    binding = canonical_oauth_binding(session_binding)
    if callback_mode not in {"loopback", "hosted"}:
        raise TeamRequestError("OAuth callback mode is invalid.")
    response = team_client._call(
        "POST",
        f"/v1/teams/{canonical_id}/assistant-accounts/challenges/{canonical_challenge}/authorize",
        {"session_binding": binding},
    )
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


def disconnect_assistant_account(
    team_id: object,
    assistant_id: object,
    account_id: object,
) -> TeamResponse:
    canonical_id = _canonical_team_id(team_id)
    assistant = chat_payloads.canonical_assistant_id(assistant_id)
    account = chat_payloads.canonical_assistant_id(account_id)
    response = team_client._call(
        "DELETE",
        f"/v1/teams/{canonical_id}/assistant-accounts/{assistant}/{account}",
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
    response = team_client._call(
        "POST",
        "/v1/oauth/cloudflare/callback",
        {"state": identifier, "claim": one_time_claim, "session_binding": binding},
    )
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"connected", "team_id", "assistant_id", "account_id", "trace_id"}:
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
            "assistant_id": chat_payloads.canonical_assistant_id(response.body["assistant_id"]),
            "account_id": chat_payloads.canonical_assistant_id(response.body["account_id"]),
        }
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team returned an invalid OAuth callback response")
        return TeamResponse(502, {"detail": "OAuth callback response is invalid."})
    return TeamResponse(200, body)
