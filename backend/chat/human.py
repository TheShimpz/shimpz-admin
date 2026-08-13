"""Fail-closed browser projection for Team-owned Action human challenges."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import auth
from team import bridge as team

from protocol.http.v1 import websocket as chat_ws_common

MAX_TTL_SECONDS = 300
MAX_AUTH_SECRET_CHARS = 4096
MAX_REQUESTS_PER_ACTION = 8
MAX_PASSWORD_ATTEMPTS = 3
PASSWORD_LOCK_SECONDS = 60
LENGTH_KINDS = {
    "input:text": 4096,
    "input:textarea": 16_000,
    "input:password": 1024,
    "input:phone": 64,
}
CHOICE_KINDS = frozenset({"input:select", "input:choice"})
AUTH_KINDS = frozenset(
    {
        "auth:password",
        "auth:totp",
        "auth:passkey",
    }
)
RESPONSE_FIELDS = frozenset(
    {
        "team_id",
        "status",
        "turn_id",
        "challenge_id",
        "expires_in",
        "assistant",
        "action",
        "request",
        "trace_id",
    }
)
_BASE_FIELDS = frozenset({"kind", "ordinal", "title", "description", "fingerprint"})
log = logging.getLogger("shimpz-admin")


class HumanChallengeError(ValueError):
    """The Team response is not one exact public human challenge."""


@dataclass(frozen=True, slots=True)
class AuthenticationResult:
    status: str
    attempts_remaining: int = 0
    retry_after: int = 0


class LocalPasswordAuthority:
    """Serialize the one Local Supervisor's bounded Action password ceremony."""

    def __init__(
        self,
        verify: Callable[[str, str], Awaitable[str]],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._verify = verify
        self._clock = clock
        self._lock = asyncio.Lock()
        self._failures = 0
        self._locked_until = 0.0

    async def __call__(self, kind: str, secret: str) -> AuthenticationResult:
        async with self._lock:
            now = self._clock()
            if self._locked_until > now:
                return AuthenticationResult(
                    "locked",
                    retry_after=max(1, math.ceil(self._locked_until - now)),
                )
            if self._locked_until:
                self._failures = 0
                self._locked_until = 0.0

            result = await self._verify(kind, secret)
            if result == "verified":
                self._failures = 0
                self._locked_until = 0.0
                return AuthenticationResult("verified")
            if result != "denied":
                return AuthenticationResult("unavailable")

            self._failures += 1
            remaining = MAX_PASSWORD_ATTEMPTS - self._failures
            if remaining > 0:
                log.info("Action password was rejected; remaining attempts: %d", remaining)
                return AuthenticationResult("denied", attempts_remaining=remaining)

            self._locked_until = self._clock() + PASSWORD_LOCK_SECONDS
            log.info("Action password was locked after repeated rejection")
            return AuthenticationResult("locked", retry_after=PASSWORD_LOCK_SECONDS)


async def authenticate_local(
    kind: str,
    secret: str,
    *,
    profile: str,
    record_get: Callable[[], dict[str, object]],
) -> str:
    """Return one bounded Local assurance outcome without exposing factor material."""
    if profile != "local" or kind != "auth:password" or not 1 <= len(secret) <= MAX_AUTH_SECRET_CHARS:
        return "unavailable"
    try:
        record = record_get()
        verified = await asyncio.to_thread(
            auth.verify_password,
            secret,
            record.get("salt", ""),
            record.get("password_hash", ""),
        )
    except TypeError, ValueError, RuntimeError, OSError:
        log.warning("Action password authority is unavailable")
        return "unavailable"
    return "verified" if verified else "denied"


def project(body: object, team_id: str) -> dict[str, object]:
    """Return one immutable-ready public challenge or fail without reflecting input."""
    if not isinstance(body, dict) or set(body) != RESPONSE_FIELDS:
        raise HumanChallengeError("invalid human challenge envelope")
    if body["team_id"] != team_id or body["status"] != "human-required":
        raise HumanChallengeError("invalid human challenge identity")
    identity = chat_ws_common.challenge_identity(body, team_id)
    if identity is None or not _trace_id(body["trace_id"]):
        raise HumanChallengeError("invalid human challenge identity")
    challenge_id, turn_id = identity
    expires_in = body["expires_in"]
    if type(expires_in) is not int or not 1 <= expires_in <= MAX_TTL_SECONDS:
        raise HumanChallengeError("invalid human challenge expiry")
    assistant = _assistant(body["assistant"])
    action = _action(body["action"])
    request = _request(body["request"])
    return {
        "team_id": team_id,
        "status": "human-required",
        "turn_id": turn_id,
        "challenge_id": challenge_id,
        "expires_in": expires_in,
        "assistant": assistant,
        "action": action,
        "request": request,
    }


def _assistant(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"id", "name", "version"}:
        raise HumanChallengeError("invalid human challenge Assistant")
    try:
        assistant_id = team.canonical_assistant_id(value["id"])
        name = chat_ws_common.public_text(value["name"], 80)
        version = chat_ws_common.public_text(value["version"], 40, field="Assistant version")
    except (ValueError, team.TeamRequestError) as exc:
        raise HumanChallengeError("invalid human challenge Assistant") from exc
    return {"id": assistant_id, "name": name, "version": version}


def _action(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"id", "summary"}:
        raise HumanChallengeError("invalid human challenge Action")
    try:
        action_id = team.canonical_assistant_id(value["id"])
        summary = chat_ws_common.public_text(value["summary"], 160)
    except (ValueError, team.TeamRequestError) as exc:
        raise HumanChallengeError("invalid human challenge Action") from exc
    return {"id": action_id, "summary": summary}


def _request(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise HumanChallengeError("invalid human request")
    request = dict(value)
    fingerprint = request.pop("fingerprint", None)
    if not isinstance(fingerprint, str) or not _fingerprint(request, fingerprint):
        raise HumanChallengeError("invalid human request fingerprint")
    kind = request.get("kind")
    ordinal = request.get("ordinal")
    if (
        not isinstance(kind, str)
        or type(ordinal) is not int
        or not 0 <= ordinal < MAX_REQUESTS_PER_ACTION
        or not _text(request.get("title"), 80)
        or not _text(request.get("description"), 500)
        or not _kind(request, kind)
    ):
        raise HumanChallengeError("invalid human request")
    return {**request, "fingerprint": fingerprint}


def _kind(request: dict[str, object], kind: str) -> bool:
    fields = set(request)
    base = _BASE_FIELDS - {"fingerprint"}
    if kind == "approval" or kind in AUTH_KINDS:
        return fields == base
    if kind in LENGTH_KINDS:
        return fields == base | {"label", "required", "placeholder", "min_length", "max_length"} and _length(
            request, LENGTH_KINDS[kind]
        )
    if kind in CHOICE_KINDS:
        return fields == base | {"label", "required", "options"} and _choices(request, multiple=False)
    if kind == "input:choices":
        return fields == base | {
            "label",
            "required",
            "options",
            "min_selections",
            "max_selections",
        } and _choices(request, multiple=True)
    return False


def _length(request: dict[str, object], limit: int) -> bool:
    minimum = request.get("min_length")
    maximum = request.get("max_length")
    placeholder = request.get("placeholder")
    return (
        _input_base(request)
        and (placeholder is None or _text(placeholder, 120))
        and type(minimum) is int
        and type(maximum) is int
        and 0 <= minimum <= maximum <= limit
    )


def _choices(request: dict[str, object], *, multiple: bool) -> bool:
    options = request.get("options")
    if (
        not _input_base(request)
        or not isinstance(options, list)
        or not 2 <= len(options) <= 32
        or not all(_option(option) for option in options)
    ):
        return False
    values = [option["value"] for option in options]
    if len(values) != len(set(values)):
        return False
    if not multiple:
        return True
    minimum = request.get("min_selections")
    maximum = request.get("max_selections")
    return type(minimum) is int and type(maximum) is int and 0 <= minimum <= maximum <= len(options)


def _input_base(request: dict[str, object]) -> bool:
    return type(request.get("required")) is bool and _text(request.get("label"), 80)


def _option(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"value", "label", "description"}
        and _text(value.get("value"), 128)
        and _text(value.get("label"), 80)
        and (value.get("description") is None or _text(value.get("description"), 160))
    )


def _text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and value == value.strip() and 0 < len(value) <= maximum and value.isprintable()


def _fingerprint(request: dict[str, object], supplied: str) -> bool:
    try:
        canonical = json.dumps(
            request,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    except TypeError, ValueError, UnicodeError, RecursionError:
        return False
    expected = hashlib.sha256(canonical).hexdigest()
    return hmac.compare_digest(supplied, expected)


def _trace_id(value: object) -> bool:
    return isinstance(value, str) and chat_ws_common.HEX_ID_RE.fullmatch(value) is not None


def browser_value(request: object, value: object) -> bool:
    """Validate a browser response against the exact already-projected request descriptor."""
    valid = False
    if isinstance(request, dict):
        kind = request.get("kind")
        if kind == "approval":
            valid = value is True
        elif kind in AUTH_KINDS:
            valid = isinstance(value, str) and 1 <= len(value) <= 4096
        elif kind in CHOICE_KINDS:
            valid = _browser_choice(request, value)
        elif kind == "input:choices":
            valid = _browser_choices(request, value)
        elif kind in LENGTH_KINDS:
            valid = _browser_text(request, value)
    return valid


def _browser_choice(request: dict[str, object], value: object) -> bool:
    options = request.get("options")
    allowed = (
        {option["value"] for option in options if isinstance(option, dict)} if isinstance(options, list) else set()
    )
    return isinstance(value, str) and (value in allowed or (value == "" and request.get("required") is False))


def _browser_text(request: dict[str, object], value: object) -> bool:
    minimum = request.get("min_length")
    maximum = request.get("max_length")
    return (
        isinstance(value, str)
        and type(minimum) is int
        and type(maximum) is int
        and (request.get("required") is False or bool(value))
        and minimum <= len(value) <= maximum
    )


def _browser_choices(request: dict[str, object], value: object) -> bool:
    options = request.get("options")
    minimum = request.get("min_selections")
    maximum = request.get("max_selections")
    if (
        not isinstance(options, list)
        or not isinstance(value, list)
        or not all(isinstance(item, str) for item in value)
        or len(value) != len(set(value))
        or type(minimum) is not int
        or type(maximum) is not int
    ):
        return False
    allowed = {option["value"] for option in options if isinstance(option, dict)}
    return minimum <= len(value) <= maximum and set(value) <= allowed
