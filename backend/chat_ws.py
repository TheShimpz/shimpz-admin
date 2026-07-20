"""Bounded, session-authenticated WebSocket transport for local Team chat.

The browser speaks only ``shimpz.chat.v3``. Provider and Assistant secrets stay behind
:mod:`localchat`; this module admits one mutating operation per socket, keeps Stop responsive on its
own bounded worker lane, and projects controller state onto small, exact public schemas.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import re
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

import localchat
import teams
from fastapi import WebSocket, WebSocketDisconnect

CHAT_SUBPROTOCOL = "shimpz.chat.v3"
MAX_FRAME_BYTES = 512 * 1024
MAX_PUBLIC_REPLY_CHARS = 60_000
MAX_PUBLIC_TEAM_NAME_CHARS = 80
MAX_PUBLIC_ERROR_CHARS = 800
MAX_PUBLIC_LABEL_CHARS = 80
MAX_PUBLIC_SUMMARY_CHARS = 160
MAX_SECRET_REQUIREMENTS = 16
MAX_SECRET_VALUES = 64
MAX_SECRETS_PER_ASSISTANT = 32
MAX_POWERS_PER_ASSISTANT = 128
MAX_INSTALLED_ASSISTANTS = 128
MAX_APPROVAL_REQUIREMENTS = 64
MAX_CONNECTION_REQUIREMENTS = 64
MAX_CONNECTION_SCOPES = 32
MAX_CONNECTION_POWERS = 128
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
_REPLY_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_OPAQUE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CHAT_ERROR_DETAILS = {
    "assistant-power-blocked": "Assistant Power execution is blocked until it is reinstalled",
    "assistant-approval-challenge-expired": "the Assistant approval expired; retry the message",
    "assistant-approval-state-unavailable": "remembered Assistant approvals are unavailable",
    "assistant-connection-challenge-expired": "the Assistant connection expired; retry the message",
    "assistant-connection-contract-invalid": "the Assistant connection contract changed; retry the message",
    "assistant-connection-state-unavailable": "Assistant connection state is unavailable",
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
    "power-approval-required": "an Assistant Power requires approval",
    "power-state-unavailable": "the Team Power execution state is unavailable",
    "runtime-unavailable": "the local chat runtime is unavailable; update this Shimpz Space",
    "secret-challenge-response-invalid": "the Assistant secret challenge was invalid",
    "secret-inventory-response-invalid": "the Assistant secret inventory was invalid",
    "approval-challenge-response-invalid": "the Assistant approval challenge was invalid",
    "approval-inventory-response-invalid": "the remembered Assistant approvals were invalid",
    "connection-challenge-response-invalid": "the Assistant connection challenge was invalid",
    "team-context-changed": "the Team capabilities changed; retry",
    "team-has-no-active-assistants": "install and start at least one Assistant before chatting",
}


class FrameError(ValueError):
    def __init__(self, status: int, detail: str, close_code: int = 1007) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.close_code = close_code


class ExecutorSaturatedError(RuntimeError):
    """The fixed worker and queue budget has no free admission slot."""


class BoundedExecutor:
    """A ThreadPoolExecutor with non-blocking admission in front of its otherwise unbounded queue."""

    def __init__(self, *, workers: int, outstanding: int, name: str) -> None:
        if workers < 1 or outstanding < workers:
            raise ValueError("invalid bounded executor capacity")
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix=name)
        self._slots = threading.BoundedSemaphore(outstanding)

    def submit(self, function: Callable, /, *args) -> concurrent.futures.Future:
        if not self._slots.acquire(blocking=False):
            raise ExecutorSaturatedError("chat worker capacity reached")
        try:
            future = self._executor.submit(function, *args)
        except BaseException:
            self._slots.release()
            raise
        future.add_done_callback(lambda _completed: self._slots.release())
        return future

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


# Turns and cancellation use separate bounded lanes: a slow provider can never consume the worker
# needed to revoke it. The local controller remains the authoritative per-Team admission boundary.
_TURN_EXECUTOR = BoundedExecutor(workers=2, outstanding=2, name="shimpz-chat-turn")
_STOP_EXECUTOR = BoundedExecutor(workers=2, outstanding=4, name="shimpz-chat-stop")
_SYNC_EXECUTOR = BoundedExecutor(workers=2, outstanding=4, name="shimpz-chat-sync")


def canonical_origin(value: str | None) -> str | None:
    """Return one exact HTTP(S) Origin, preserving an explicitly supplied port."""
    if not value or value == "null":
        return None
    try:
        parsed = urlparse(value)
        _ = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _configured_origins() -> frozenset[str]:
    configured = os.environ.get("SHIMPZ_ADMIN_ALLOWED_ORIGINS", _DEFAULT_ORIGINS)
    return frozenset(origin for item in configured.split(",") if (origin := canonical_origin(item.strip())) is not None)


ALLOWED_ORIGINS = _configured_origins()


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


async def receive_bounded_json(websocket: WebSocket) -> dict[str, object]:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    if message["type"] != "websocket.receive":
        raise FrameError(400, "invalid WebSocket frame")

    text = message.get("text")
    if text is None or message.get("bytes") is not None:
        raise FrameError(415, "WebSocket frame must be text JSON", 1003)
    try:
        encoded = text.encode("utf-8")
    except UnicodeError as exc:
        raise FrameError(400, "WebSocket frame must be UTF-8 JSON") from exc
    if len(encoded) > MAX_FRAME_BYTES:
        raise FrameError(413, "WebSocket frame too large", 1009)
    raw = text

    try:
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_json_constant)
    except json.JSONDecodeError, UnicodeError, ValueError, RecursionError:
        raise FrameError(400, "WebSocket frame must be valid unique-key JSON") from None
    if not isinstance(value, dict):
        raise FrameError(400, "WebSocket JSON must be an object")
    return value


def _valid_team_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= MAX_PUBLIC_TEAM_NAME_CHARS
        and _CONTROL_RE.search(value) is None
    )


def _valid_reply(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= MAX_PUBLIC_REPLY_CHARS
        and _REPLY_CONTROL_RE.search(value) is None
    )


def _safe_status(value: object, fallback: int = 502) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and 400 <= value <= 599 else fallback


def _error_terminal(status: object, detail: str = "local chat request failed") -> dict[str, object]:
    safe_detail = (
        detail
        if 0 < len(detail) <= MAX_PUBLIC_ERROR_CHARS and _CONTROL_RE.search(detail) is None
        else "local chat request failed"
    )
    return {"type": "error", "status": _safe_status(status), "detail": safe_detail}


def turn_terminal(response: object, team_id: str) -> dict[str, object]:
    """Project a secret-safe localchat response onto the public v3 terminal contract."""
    if not isinstance(response, teams.DriverResponse):
        return _error_terminal(502)
    if isinstance(response.status, int) and not isinstance(response.status, bool) and 200 <= response.status < 300:
        body = response.body
        if (
            isinstance(body, dict)
            and set(body) == {"team_id", "team_name", "reply"}
            and body.get("team_id") == team_id
            and _valid_team_name(body.get("team_name"))
            and _valid_reply(body.get("reply"))
        ):
            return {
                "type": "done",
                "team_id": team_id,
                "team_name": body["team_name"],
                "reply": body["reply"],
            }
        return _error_terminal(502, "local chat returned an invalid response")

    # ``localchat`` reduces controller/provider failures to one bounded machine code. Map only this
    # closed allowlist to fixed public text; raw prose, tracebacks and credentials never cross here.
    details = {
        400: "invalid chat request",
        409: "chat turn could not start",
        429: "local chat capacity reached",
        503: "local chat runtime is unavailable",
    }
    status = _safe_status(response.status)
    fallback = details.get(status, "local chat request failed")
    body = response.body
    if not isinstance(body, dict) or set(body) != {"code"}:
        return _error_terminal(status, fallback)
    code = body.get("code")
    if not isinstance(code, str) or code not in _CHAT_ERROR_DETAILS:
        return _error_terminal(status, fallback)
    return _error_terminal(status, f"{code}: {_CHAT_ERROR_DETAILS[code]}")


def _canonical_assistant_id(value: object) -> str | None:
    try:
        return teams.canonical_assistant_id(value)
    except teams.TeamRequestError:
        return None


def _valid_public_text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and value == value.strip() and 0 < len(value) <= maximum and value.isprintable()


def _canonical_secret_metadata(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"id", "name", "summary"}:
        return None
    secret_id = _canonical_assistant_id(value.get("id"))
    if (
        secret_id is None
        or not _valid_public_text(value.get("name"), MAX_PUBLIC_LABEL_CHARS)
        or not _valid_public_text(value.get("summary"), MAX_PUBLIC_SUMMARY_CHARS)
    ):
        return None
    return {"id": secret_id, "name": value["name"], "summary": value["summary"]}


def secret_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    """Return one exact public challenge without ever copying submitted secret values."""
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or (response.status != 428 and not 200 <= response.status < 300)
        or not isinstance(response.body, dict)
        or set(response.body) != {"team_id", "status", "turn_id", "challenge_id", "requirements"}
        or response.body.get("team_id") != team_id
        or response.body.get("status") != "secrets-required"
    ):
        return None
    turn_id = response.body.get("turn_id")
    challenge_id = response.body.get("challenge_id")
    raw_requirements = response.body.get("requirements")
    if (
        not isinstance(turn_id, str)
        or _OPAQUE_ID_RE.fullmatch(turn_id) is None
        or not isinstance(challenge_id, str)
        or _OPAQUE_ID_RE.fullmatch(challenge_id) is None
        or not isinstance(raw_requirements, list)
        or not 1 <= len(raw_requirements) <= MAX_SECRET_REQUIREMENTS
    ):
        return None

    requirements: list[dict[str, object]] = []
    seen_assistants: set[str] = set()
    total_secrets = 0
    for raw in raw_requirements:
        if not isinstance(raw, dict) or set(raw) != {"assistant_id", "assistant_name", "power_ids", "secrets"}:
            return None
        assistant_id = _canonical_assistant_id(raw.get("assistant_id"))
        power_ids = raw.get("power_ids")
        raw_secrets = raw.get("secrets")
        if (
            assistant_id is None
            or assistant_id in seen_assistants
            or not _valid_public_text(raw.get("assistant_name"), MAX_PUBLIC_LABEL_CHARS)
            or not isinstance(power_ids, list)
            or not 1 <= len(power_ids) <= MAX_POWERS_PER_ASSISTANT
            or not isinstance(raw_secrets, list)
            or not 1 <= len(raw_secrets) <= MAX_SECRETS_PER_ASSISTANT
        ):
            return None
        canonical_powers = [_canonical_assistant_id(power_id) for power_id in power_ids]
        if any(power_id is None for power_id in canonical_powers) or len(set(canonical_powers)) != len(
            canonical_powers
        ):
            return None
        secrets = [_canonical_secret_metadata(secret) for secret in raw_secrets]
        if any(secret is None for secret in secrets):
            return None
        secret_ids = [secret["id"] for secret in secrets if secret is not None]
        if len(set(secret_ids)) != len(secret_ids):
            return None
        total_secrets += len(secrets)
        if total_secrets > MAX_SECRET_VALUES:
            return None
        seen_assistants.add(assistant_id)
        requirements.append(
            {
                "assistant_id": assistant_id,
                "assistant_name": raw["assistant_name"],
                "power_ids": canonical_powers,
                "secrets": secrets,
            }
        )
    return {
        "type": "secrets-required",
        "turn_id": turn_id,
        "challenge_id": challenge_id,
        "requirements": requirements,
    }


def approval_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    """Return an exact, bounded operation preview for explicit human approval."""
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or (response.status != 428 and not 200 <= response.status < 300)
        or not isinstance(response.body, dict)
        or set(response.body) != {"team_id", "status", "turn_id", "challenge_id", "requirements"}
        or response.body.get("team_id") != team_id
        or response.body.get("status") != "approval-required"
    ):
        return None
    turn_id = response.body.get("turn_id")
    challenge_id = response.body.get("challenge_id")
    raw_requirements = response.body.get("requirements")
    if (
        not isinstance(turn_id, str)
        or _OPAQUE_ID_RE.fullmatch(turn_id) is None
        or not isinstance(challenge_id, str)
        or _OPAQUE_ID_RE.fullmatch(challenge_id) is None
        or not isinstance(raw_requirements, list)
        or not 1 <= len(raw_requirements) <= MAX_APPROVAL_REQUIREMENTS
    ):
        return None
    requirements: list[dict[str, object]] = []
    for raw in raw_requirements:
        if not isinstance(raw, dict) or set(raw) != {
            "assistant_id",
            "assistant_name",
            "power_id",
            "power_summary",
            "input",
            "approval",
        }:
            return None
        assistant_id = _canonical_assistant_id(raw.get("assistant_id"))
        power_id = _canonical_assistant_id(raw.get("power_id"))
        try:
            power_input = localchat._bounded_approval_input(raw.get("input"))
        except TypeError, ValueError:
            return None
        if (
            assistant_id is None
            or power_id is None
            or not _valid_public_text(raw.get("assistant_name"), MAX_PUBLIC_LABEL_CHARS)
            or not _valid_public_text(raw.get("power_summary"), MAX_PUBLIC_SUMMARY_CHARS)
            or raw.get("approval") not in {"always", "once"}
        ):
            return None
        requirements.append(
            {
                "assistant_id": assistant_id,
                "assistant_name": raw["assistant_name"],
                "power_id": power_id,
                "power_summary": raw["power_summary"],
                "input": power_input,
                "approval": raw["approval"],
            }
        )
    return {
        "type": "approval-required",
        "turn_id": turn_id,
        "challenge_id": challenge_id,
        "requirements": requirements,
    }


def connection_challenge_event(response: object, team_id: str) -> dict[str, object] | None:
    """Return exact public OAuth consent metadata without copying authorization material."""
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or (response.status != 428 and not 200 <= response.status < 300)
        or not isinstance(response.body, dict)
        or set(response.body)
        != {"team_id", "status", "turn_id", "challenge_id", "expires_in", "requirements"}
        or response.body.get("team_id") != team_id
        or response.body.get("status") != "connections-required"
    ):
        return None
    turn_id = response.body.get("turn_id")
    challenge_id = response.body.get("challenge_id")
    expires_in = response.body.get("expires_in")
    raw_requirements = response.body.get("requirements")
    if (
        not isinstance(turn_id, str)
        or _OPAQUE_ID_RE.fullmatch(turn_id) is None
        or not isinstance(challenge_id, str)
        or _OPAQUE_ID_RE.fullmatch(challenge_id) is None
        or not isinstance(expires_in, int)
        or isinstance(expires_in, bool)
        or not 1 <= expires_in <= 900
        or not isinstance(raw_requirements, list)
        or not 1 <= len(raw_requirements) <= MAX_CONNECTION_REQUIREMENTS
    ):
        return None

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
            return None
        assistant_id = _canonical_assistant_id(raw.get("assistant_id"))
        connection_id = _canonical_assistant_id(raw.get("connection_id"))
        provider = _canonical_assistant_id(raw.get("provider"))
        raw_scopes = raw.get("scopes")
        raw_powers = raw.get("powers")
        if (
            assistant_id is None
            or connection_id is None
            or provider is None
            or (assistant_id, connection_id) in seen_connections
            or not _valid_public_text(raw.get("assistant_name"), MAX_PUBLIC_LABEL_CHARS)
            or not _valid_public_text(raw.get("name"), MAX_PUBLIC_LABEL_CHARS)
            or not _valid_public_text(raw.get("summary"), MAX_PUBLIC_SUMMARY_CHARS)
            or not isinstance(raw_scopes, list)
            or not 1 <= len(raw_scopes) <= MAX_CONNECTION_SCOPES
            or not isinstance(raw_powers, list)
            or not 1 <= len(raw_powers) <= MAX_CONNECTION_POWERS
        ):
            return None
        if any(not _valid_public_text(scope, 128) for scope in raw_scopes) or len(set(raw_scopes)) != len(raw_scopes):
            return None
        powers: list[dict[str, str]] = []
        seen_powers: set[str] = set()
        for raw_power in raw_powers:
            if not isinstance(raw_power, dict) or set(raw_power) != {"id", "name", "summary"}:
                return None
            power_id = _canonical_assistant_id(raw_power.get("id"))
            if (
                power_id is None
                or power_id in seen_powers
                or not _valid_public_text(raw_power.get("name"), MAX_PUBLIC_LABEL_CHARS)
                or not _valid_public_text(raw_power.get("summary"), MAX_PUBLIC_SUMMARY_CHARS)
            ):
                return None
            seen_powers.add(power_id)
            powers.append({"id": power_id, "name": raw_power["name"], "summary": raw_power["summary"]})
        seen_connections.add((assistant_id, connection_id))
        requirements.append(
            {
                "assistant_id": assistant_id,
                "assistant_name": raw["assistant_name"],
                "connection_id": connection_id,
                "provider": provider,
                "name": raw["name"],
                "summary": raw["summary"],
                "scopes": list(raw_scopes),
                "powers": powers,
            }
        )
    return {
        "type": "connections-required",
        "challenge_id": challenge_id,
        "expires_in": expires_in,
        "requirements": requirements,
    }


def _valid_secret_mask(value: object) -> bool:
    if value == "••••":
        return True
    if not isinstance(value, str) or not value.isprintable():
        return False
    characters = list(value)
    if len(characters) not in {3, 5, 7, 9}:
        return False
    middle = len(characters) // 2
    return 1 <= middle <= 4 and characters[middle] == "…"


def secret_inventory_event(response: object, team_id: str) -> dict[str, object] | None:
    """Return one exact Team-bound inventory containing metadata and masks only."""
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
        or set(response.body) != {"team_id", "assistants"}
        or response.body.get("team_id") != team_id
    ):
        return None
    raw_assistants = response.body.get("assistants")
    if not isinstance(raw_assistants, list) or len(raw_assistants) > MAX_INSTALLED_ASSISTANTS:
        return None
    assistants: list[dict[str, object]] = []
    seen_assistants: set[str] = set()
    for raw in raw_assistants:
        if not isinstance(raw, dict) or set(raw) != {"id", "name", "secrets"}:
            return None
        assistant_id = _canonical_assistant_id(raw.get("id"))
        raw_secrets = raw.get("secrets")
        if (
            assistant_id is None
            or assistant_id in seen_assistants
            or not _valid_public_text(raw.get("name"), MAX_PUBLIC_LABEL_CHARS)
            or not isinstance(raw_secrets, list)
            or len(raw_secrets) > MAX_SECRETS_PER_ASSISTANT
        ):
            return None
        secrets: list[dict[str, object]] = []
        seen_secrets: set[str] = set()
        for raw_secret in raw_secrets:
            if not isinstance(raw_secret, dict) or set(raw_secret) != {"id", "name", "summary", "configured", "mask"}:
                return None
            metadata = _canonical_secret_metadata({key: raw_secret[key] for key in ("id", "name", "summary")})
            configured = raw_secret.get("configured")
            mask = raw_secret.get("mask")
            if (
                metadata is None
                or metadata["id"] in seen_secrets
                or not isinstance(configured, bool)
                or (configured and not _valid_secret_mask(mask))
                or (not configured and mask is not None)
            ):
                return None
            seen_secrets.add(metadata["id"])
            secrets.append({**metadata, "configured": configured, "mask": mask})
        seen_assistants.add(assistant_id)
        assistants.append({"id": assistant_id, "name": raw["name"], "secrets": secrets})
    return {"type": "secret-inventory", "team_id": team_id, "assistants": assistants}


def _stop_accepted(response: object, team_id: str) -> bool | None:
    if (
        not isinstance(response, teams.DriverResponse)
        or not isinstance(response.status, int)
        or isinstance(response.status, bool)
        or not 200 <= response.status < 300
        or not isinstance(response.body, dict)
    ):
        return None
    if set(response.body) != {"team_id", "stopped"} or response.body.get("team_id") != team_id:
        return None
    stopped = response.body.get("stopped")
    return stopped if isinstance(stopped, bool) else None


@dataclass(slots=True)
class _Turn:
    future: concurrent.futures.Future | None
    operation: str
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False


@dataclass(slots=True)
class _Connection:
    active: _Turn | None = None
    pending_challenge_id: str | None = None
    pending_challenge_type: str | None = None
    sync_task: asyncio.Task | None = None
    closed: bool = False


async def _send_event(websocket: WebSocket, event: Mapping[str, object]) -> bool:
    try:
        await websocket.send_json(dict(event))
    except WebSocketDisconnect, RuntimeError, OSError:
        return False
    return True


async def _send_terminal_once(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    event: Mapping[str, object],
) -> bool:
    if connection.closed or turn.terminal_sent:
        return False
    turn.terminal_sent = True
    if not await _send_event(websocket, event):
        connection.closed = True
        return False
    return True


async def _deliver_turn(websocket: WebSocket, connection: _Connection, turn: _Turn, team_id: str) -> None:
    try:
        response = teams.DriverResponse(502, {})
        # A provider callback may raise any ordinary exception. This process boundary must fail
        # closed while cancellation and process-control BaseExceptions continue to propagate.
        with contextlib.suppress(Exception):
            try:
                if turn.future is not None:
                    response = await asyncio.wrap_future(turn.future)
            except asyncio.CancelledError:
                raise
            except teams.TeamRequestError:
                response = teams.DriverResponse(400, {})
        if connection.closed or turn.stop_requested or turn.terminal_sent:
            return
        challenge = connection_challenge_event(response, team_id)
        challenge_type = "connection"
        if challenge is None:
            challenge = secret_challenge_event(response, team_id)
            challenge_type = "secret"
        if challenge is None:
            challenge = approval_challenge_event(response, team_id)
            challenge_type = "approval"
        if challenge is not None:
            connection.pending_challenge_id = challenge["challenge_id"]
            connection.pending_challenge_type = challenge_type
            if not await _send_event(websocket, challenge):
                connection.closed = True
            return
        if isinstance(response, teams.DriverResponse) and (
            response.status == 428
            or (
                isinstance(response.body, dict)
                and response.body.get("status")
                in {"connections-required", "secrets-required", "approval-required"}
            )
        ):
            event = _error_terminal(502, "the Assistant challenge was invalid")
        else:
            event = turn_terminal(response, team_id)
        if event.get("type") == "done":
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
        await _send_terminal_once(websocket, connection, turn, event)
    finally:
        if connection.active is turn:
            connection.active = None


def _sync_snapshot(team_id: str) -> tuple[object, object, object | None, object | None, object | None]:
    inventory = localchat.secret_inventory(team_id)
    pending_connection = localchat.pending_connections(team_id)
    connection = connection_challenge_event(pending_connection, team_id)
    if connection is not None:
        # Continuation is explicit and one-use. The OAuth callback only stores the grant; this
        # exact pending challenge remains the controller-owned binding for the paused turn.
        resumed = localchat.resume_connections(team_id, connection["challenge_id"])
        return inventory, pending_connection, resumed, None, None
    if not _is_empty_pending(pending_connection, team_id):
        return inventory, pending_connection, None, None, None
    return (
        inventory,
        pending_connection,
        None,
        localchat.pending_secrets(team_id),
        localchat.pending_approval(team_id),
    )


def _pending_secret_event(response: object, team_id: str) -> dict[str, object] | None:
    if (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and set(response.body) == {"team_id", "status"}
        and response.body.get("team_id") == team_id
        and response.body.get("status") == "none"
    ):
        return None
    return secret_challenge_event(response, team_id)


def _pending_approval_event(response: object, team_id: str) -> dict[str, object] | None:
    if (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and set(response.body) == {"team_id", "status"}
        and response.body.get("team_id") == team_id
        and response.body.get("status") == "none"
    ):
        return None
    return approval_challenge_event(response, team_id)


def _is_empty_pending(response: object, team_id: str) -> bool:
    return (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and 200 <= response.status < 300
        and isinstance(response.body, dict)
        and response.body == {"team_id": team_id, "status": "none"}
    )


def _pending_error(response: object, team_id: str, challenge_type: str) -> dict[str, object]:
    if (
        isinstance(response, teams.DriverResponse)
        and isinstance(response.status, int)
        and not isinstance(response.status, bool)
        and not 200 <= response.status < 300
    ):
        return turn_terminal(response, team_id)
    return _error_terminal(502, f"the Assistant {challenge_type} challenge was invalid")


async def _deliver_connection_sync(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    pending_response: object,
    resumed_response: object,
) -> bool:
    """Deliver an explicitly resumed connection gate; return whether it consumed sync."""
    pending = connection_challenge_event(pending_response, team_id)
    if pending is None:
        if _is_empty_pending(pending_response, team_id):
            return False
        await _send_event(websocket, _pending_error(pending_response, team_id, "connection"))
        return True
    if resumed_response is None:
        await _send_event(websocket, _error_terminal(502, "the Assistant connection challenge was invalid"))
        return True

    resumed = connection_challenge_event(resumed_response, team_id)
    challenge_type = "connection"
    if resumed is None:
        resumed = secret_challenge_event(resumed_response, team_id)
        challenge_type = "secret"
    if resumed is None:
        resumed = approval_challenge_event(resumed_response, team_id)
        challenge_type = "approval"
    if resumed is not None:
        pending_turn_id = pending_response.body.get("turn_id")
        resumed_turn_id = resumed_response.body.get("turn_id")
        if pending_turn_id != resumed_turn_id:
            await _send_event(websocket, _error_terminal(502, "the Assistant connection challenge was invalid"))
            return True
        connection.pending_challenge_id = resumed["challenge_id"]
        connection.pending_challenge_type = challenge_type
        if not await _send_event(websocket, resumed):
            connection.closed = True
        return True

    if isinstance(resumed_response, teams.DriverResponse) and (
        resumed_response.status == 428
        or (
            isinstance(resumed_response.body, dict)
            and resumed_response.body.get("status")
            in {"connections-required", "secrets-required", "approval-required"}
        )
    ):
        event = _error_terminal(502, "the Assistant connection challenge was invalid")
    else:
        event = turn_terminal(resumed_response, team_id)
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    await _send_event(websocket, event)
    return True


async def _deliver_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    task = asyncio.current_task()
    try:
        snapshot: tuple[object, object, object | None, object | None, object | None] | None = None
        try:
            future = _SYNC_EXECUTOR.submit(_sync_snapshot, team_id)
        except ExecutorSaturatedError:
            await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
            return
        with contextlib.suppress(Exception):
            snapshot = await asyncio.wrap_future(future)
        if snapshot is None:
            await _send_event(websocket, _error_terminal(502))
            return
        (
            inventory_response,
            pending_connection_response,
            resumed_connection_response,
            pending_response,
            pending_approval_response,
        ) = snapshot
        if connection.closed:
            return

        inventory = secret_inventory_event(inventory_response, team_id)
        if inventory is None:
            if (
                isinstance(inventory_response, teams.DriverResponse)
                and isinstance(inventory_response.status, int)
                and not isinstance(inventory_response.status, bool)
                and not 200 <= inventory_response.status < 300
            ):
                event = turn_terminal(inventory_response, team_id)
            else:
                event = _error_terminal(502, "the Assistant secret inventory was invalid")
            await _send_event(websocket, event)
            return
        if not await _send_event(websocket, inventory):
            connection.closed = True
            return

        if await _deliver_connection_sync(
            websocket,
            connection,
            team_id,
            pending_connection_response,
            resumed_connection_response,
        ):
            return

        pending = _pending_secret_event(pending_response, team_id)
        if pending is None and not _is_empty_pending(pending_response, team_id):
            await _send_event(websocket, _pending_error(pending_response, team_id, "secret"))
            return

        approval = _pending_approval_event(pending_approval_response, team_id)
        if approval is None and not _is_empty_pending(pending_approval_response, team_id):
            await _send_event(websocket, _pending_error(pending_approval_response, team_id, "approval"))
            return
        if pending is not None and approval is not None:
            await _send_event(websocket, _error_terminal(502, "conflicting Assistant challenges"))
            return
        challenge = pending or approval
        if challenge is None:
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
            return
        connection.pending_challenge_id = challenge["challenge_id"]
        connection.pending_challenge_type = "secret" if pending is not None else "approval"
        if not await _send_event(websocket, challenge):
            connection.closed = True
    finally:
        if connection.sync_task is task:
            connection.sync_task = None


async def _run_stop(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    team_id: str,
    *,
    emit: bool,
) -> None:
    try:
        response = teams.DriverResponse(502, {})
        # Stop has the same fail-closed callback boundary as turn delivery.
        with contextlib.suppress(Exception):
            try:
                response = await asyncio.wrap_future(_STOP_EXECUTOR.submit(localchat.stop, team_id))
            except ExecutorSaturatedError:
                response = teams.DriverResponse(429, {})
        accepted = _stop_accepted(response, team_id)
        if not emit or connection.closed or turn.terminal_sent:
            return
        if accepted is True:
            connection.pending_challenge_id = None
            connection.pending_challenge_type = None
            await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
        elif accepted is None:
            status = response.status if isinstance(response, teams.DriverResponse) else 502
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                _error_terminal(status, "chat turn could not be stopped"),
            )
        elif turn.operation == "pending-stop":
            await _send_terminal_once(
                websocket,
                connection,
                turn,
                _error_terminal(409, "no active chat turn"),
            )
        # ``False`` races safely with a turn that has already finished; its normal terminal wins.
    finally:
        turn.stop_task = None
        if turn.operation == "pending-stop" and turn.terminal_sent and connection.active is turn:
            connection.active = None


async def _finish_cancelled_turn(websocket: WebSocket, connection: _Connection, turn: _Turn) -> None:
    try:
        await _send_terminal_once(websocket, connection, turn, {"type": "stopped"})
    finally:
        if connection.active is turn:
            connection.active = None


def _request_stop(
    websocket: WebSocket,
    connection: _Connection,
    turn: _Turn,
    team_id: str,
    *,
    emit: bool,
) -> asyncio.Task | None:
    if turn.stop_requested:
        return turn.stop_task
    turn.stop_requested = True
    cancelled = turn.future is not None and turn.future.cancel()
    if cancelled and connection.pending_challenge_id is None:
        if emit and not connection.closed:
            turn.stop_task = asyncio.create_task(_finish_cancelled_turn(websocket, connection, turn))
        return turn.stop_task
    turn.stop_task = asyncio.create_task(_run_stop(websocket, connection, turn, team_id, emit=emit))
    return turn.stop_task


async def _dispatch_sync(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    if connection.sync_task is not None or connection.active is not None:
        await _send_event(websocket, _error_terminal(409, "a chat operation is already active"))
        return
    connection.sync_task = asyncio.create_task(_deliver_sync(websocket, connection, team_id))


async def _dispatch_chat(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
) -> None:
    if set(frame) != {"type", "message", "files", "assistant_ids"}:
        await _send_event(
            websocket,
            _error_terminal(400, "chat frame requires message, files, and assistant_ids"),
        )
        return
    try:
        payload = teams.canonical_chat_payload({key: value for key, value in frame.items() if key != "type"})
    except teams.TeamRequestError:
        await _send_event(websocket, _error_terminal(400, "invalid chat request"))
        return
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, _error_terminal(409, "a chat turn is already active"))
        return
    if connection.pending_challenge_id is not None:
        await _send_event(
            websocket,
            _error_terminal(409, "an Assistant challenge must be resolved before another turn"),
        )
        return
    try:
        future = _TURN_EXECUTOR.submit(localchat.turn, team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation="chat")
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


async def _dispatch_secret_submit(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
) -> None:
    if set(frame) != {"type", "challenge_id", "values"}:
        await _send_event(
            websocket,
            _error_terminal(400, "secret-submit frame requires challenge_id and values"),
        )
        return
    try:
        payload = teams.canonical_secret_submission({key: value for key, value in frame.items() if key != "type"})
    except teams.TeamRequestError:
        await _send_event(websocket, _error_terminal(400, "invalid Assistant secret submission"))
        return
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, _error_terminal(409, "a chat operation is already active"))
        return
    if connection.pending_challenge_id is None:
        await _send_event(websocket, _error_terminal(409, "no Assistant secret challenge is pending"))
        return
    if connection.pending_challenge_type != "secret":
        await _send_event(websocket, _error_terminal(409, "an Assistant approval is pending"))
        return
    if payload["challenge_id"] != connection.pending_challenge_id:
        await _send_event(websocket, _error_terminal(409, "the Assistant secret challenge is stale"))
        return
    try:
        future = _TURN_EXECUTOR.submit(localchat.submit_secrets, team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation="secret-submit")
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


async def _dispatch_approval_submit(
    websocket: WebSocket,
    connection: _Connection,
    team_id: str,
    frame: dict[str, object],
) -> None:
    if set(frame) != {"type", "challenge_id", "approved"}:
        await _send_event(websocket, _error_terminal(400, "approval-submit requires challenge_id and approved"))
        return
    try:
        payload = teams.canonical_approval_submission({key: value for key, value in frame.items() if key != "type"})
    except teams.TeamRequestError:
        await _send_event(websocket, _error_terminal(400, "invalid Assistant approval submission"))
        return
    if connection.active is not None or connection.sync_task is not None:
        await _send_event(websocket, _error_terminal(409, "a chat operation is already active"))
        return
    if connection.pending_challenge_id is None:
        await _send_event(websocket, _error_terminal(409, "no Assistant approval is pending"))
        return
    if connection.pending_challenge_type != "approval":
        await _send_event(websocket, _error_terminal(409, "Assistant secrets are required"))
        return
    if payload["challenge_id"] != connection.pending_challenge_id:
        await _send_event(websocket, _error_terminal(409, "the Assistant approval challenge is stale"))
        return
    try:
        future = _TURN_EXECUTOR.submit(localchat.submit_approval, team_id, payload)
    except ExecutorSaturatedError:
        await _send_event(websocket, _error_terminal(429, "local chat capacity reached"))
        return
    turn = _Turn(future=future, operation="approval-submit")
    connection.active = turn
    turn.delivery = asyncio.create_task(_deliver_turn(websocket, connection, turn, team_id))


async def _dispatch_stop(websocket: WebSocket, connection: _Connection, team_id: str) -> None:
    if connection.active is None and connection.pending_challenge_id is None:
        await _send_event(websocket, _error_terminal(409, "no active chat turn"))
        return
    if connection.active is None:
        connection.active = _Turn(future=None, operation="pending-stop")
    _request_stop(websocket, connection, connection.active, team_id, emit=True)


async def _dispatch(websocket: WebSocket, connection: _Connection, team_id: str, frame: dict[str, object]) -> None:
    frame_type = frame.get("type")
    if frame_type == "sync" and set(frame) == {"type"}:
        await _dispatch_sync(websocket, connection, team_id)
    elif frame_type == "chat":
        await _dispatch_chat(websocket, connection, team_id, frame)
    elif frame_type == "secret-submit":
        await _dispatch_secret_submit(websocket, connection, team_id, frame)
    elif frame_type == "approval-submit":
        await _dispatch_approval_submit(websocket, connection, team_id, frame)
    elif frame_type == "stop" and set(frame) == {"type"}:
        await _dispatch_stop(websocket, connection, team_id)
    else:
        await _send_event(websocket, _error_terminal(400, "unsupported chat frame"))


def _has_subprotocol(websocket: WebSocket) -> bool:
    protocols = websocket.scope.get("subprotocols", [])
    return protocols == [CHAT_SUBPROTOCOL]


def _session_valid(session_ok: Callable[[Mapping[str, str]], bool], cookies: Mapping[str, str]) -> bool:
    # Authentication callbacks fail closed on every ordinary validation error.
    with contextlib.suppress(Exception):
        return session_ok(cookies) is True
    return False


async def serve(
    websocket: WebSocket,
    team_id: object,
    *,
    session_ok: Callable[[Mapping[str, str]], bool],
) -> None:
    """Serve one authenticated local chat socket without letting it outlive its Admin session."""
    origin = canonical_origin(websocket.headers.get("origin"))
    if origin is None or origin not in ALLOWED_ORIGINS:
        await websocket.close(code=4403)
        return
    if not _has_subprotocol(websocket):
        await websocket.close(code=4406)
        return
    try:
        canonical_id = teams.canonical_team_id(team_id)
    except teams.TeamRequestError:
        await websocket.close(code=4400)
        return
    if not _session_valid(session_ok, websocket.cookies):
        await websocket.close(code=4401)
        return

    await websocket.accept(subprotocol=CHAT_SUBPROTOCOL)
    connection = _Connection()
    try:
        while True:
            try:
                frame = await receive_bounded_json(websocket)
            except FrameError as exc:
                await _send_event(websocket, _error_terminal(exc.status, exc.detail))
                connection.closed = True
                await websocket.close(code=exc.close_code)
                return
            # A week-long cookie can expire or be rotated while a socket is open. Revalidating the
            # signed token before every operation prevents that connection from extending authority.
            if not _session_valid(session_ok, websocket.cookies):
                connection.closed = True
                await websocket.close(code=4401)
                return
            await _dispatch(websocket, connection, canonical_id, frame)
    except WebSocketDisconnect, RuntimeError, OSError:
        connection.closed = True
    finally:
        connection.closed = True
        sync_task = connection.sync_task
        if sync_task is not None:
            sync_task.cancel()
            await asyncio.gather(sync_task, return_exceptions=True)
        active = connection.active
        if active is not None:
            stop_task = active.stop_task
            if active.future is not None and not active.future.done():
                stop_task = _request_stop(websocket, connection, active, canonical_id, emit=False)
            if stop_task is not None:
                with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                    await asyncio.wait_for(asyncio.shield(stop_task), timeout=15)
            if active.delivery is not None:
                active.delivery.cancel()
                await asyncio.gather(active.delivery, return_exceptions=True)
