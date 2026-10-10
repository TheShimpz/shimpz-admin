"""Fail-closed browser projection for Team-owned Action human challenges."""

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import auth
from team import bridge as team

from protocol.http.v1 import challenge as team_challenge
from protocol.http.v1 import payload as team_contract
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
# Local Team asks only for the Supervisor password; it stops an Action that asks for auth:totp or auth:passkey as
# authentication-unavailable before any challenge reaches Admin, so Admin never projects either.
AUTH_KINDS = frozenset({"auth:password"})
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
        "rendered",
        "locale",
        "pack_digest",
        "trace_id",
    }
)
# Optional presentation beside the Assistant-authored request; never part of its fingerprint (ADR-0090). `file` is
# the platform-controlled disclosure of the one file an authorization of a file-taking Action delivers (ADR-0093), and
# `input` the platform-rendered rows of the validated Action input every chat confirmation card shows (ADR-0112).
PRESENTATION_FIELDS = frozenset({"purpose", "help", "help_url", "file", "input"})
AUTHORIZATION_KINDS = frozenset({"approval", *AUTH_KINDS})
# Team's own confirmation of a mutating Action that declares no authorization (ADR-0112). It references no catalog
# copy, so Admin words the card itself; its request names only the policy and the SHA-256 of the exact call it binds.
CONFIRMATION_KIND = "confirmation"
CONFIRMATION_POLICY = "mutating-actions"
_CONFIRMATION_FIELDS = frozenset({"kind", "ordinal", "policy", "binding"})
# The requests whose card shows the Action's input: Team's confirmation always, a declared authorization in chat.
INPUT_KINDS = frozenset({CONFIRMATION_KIND, *AUTHORIZATION_KINDS})
_BASE_FIELDS = frozenset({"kind", "ordinal", "title", "description", "fingerprint"})
# A copy field is a catalog reference (Assistant Spec v1, ADR-0091). Admin never holds the reviewed catalog, so it
# admits each reference's closed shape and parameter grammar; Team alone resolves the declared message and parameters.
MAX_REFERENCE_PARAMS = 8
_MESSAGE_ID = re.compile(r"[0-9a-f]{64}\Z")
_PARAM_NAME = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")
# Every `domain` value is also a `dns_name` value (an exact DNS record name), so one grammar admits both kinds.
_DNS_NAME_PARAM = re.compile(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\Z")
_IDENTIFIER_PARAM = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*\Z")
MAX_INTEGER_PARAM = 10**15
MAX_DNS_NAME_PARAM_CHARS = 253
MAX_IDENTIFIER_PARAM_CHARS = 128
log = logging.getLogger("shimpz-admin")


class HumanChallengeError(ValueError):
    """The Team response is not one exact public human challenge."""


@dataclass(frozen=True, slots=True)
class AuthenticationResult:
    status: str
    attempts_remaining: int = 0
    retry_after: int = 0


async def response_payload(
    frame: dict[str, object],
    request: dict[str, object],
    authenticate: Callable[[str, str], Awaitable[AuthenticationResult]],
) -> tuple[
    dict[str, object] | None,
    dict[str, str] | None,
    dict[str, object] | None,
    tuple[int, str] | None,
]:
    """Project one browser value onto the exact Team continuation payload."""
    canonical = chat_ws_common.canonical_human_response(frame)
    challenge_id = canonical["challenge_id"]
    if canonical["decision"] == "deny":
        return {"challenge_id": challenge_id, "decision": "deny"}, None, None, None
    value = canonical.pop("value")
    if not browser_value(request, value):
        raise chat_ws_common.FrameError(400, "human response does not match its request")
    kind = request.get("kind")
    if kind not in AUTH_KINDS:
        return (
            {
                "challenge_id": challenge_id,
                "decision": "submit",
                "value": value,
            },
            None,
            None,
            None,
        )
    frame.pop("value", None)
    password = value
    # browser_value already proves that authentication responses are bounded strings.
    result = AuthenticationResult("unavailable")
    with contextlib.suppress(Exception):
        result = await authenticate(kind, password)
    del password
    del value
    if result.status == "verified":
        return (
            {
                "challenge_id": challenge_id,
                "decision": "submit",
                "value": True,
            },
            {"kind": kind, "challenge_id": challenge_id},
            None,
            None,
        )
    if result.status in {"denied", "locked"}:
        reason = "authentication-denied" if result.status == "denied" else "authentication-locked"
        return (
            None,
            None,
            {
                "type": "human-response-rejected",
                "challenge_id": challenge_id,
                "reason": reason,
                "attempts_remaining": result.attempts_remaining,
                "retry_after": result.retry_after,
            },
            None,
        )
    return (
        {"challenge_id": challenge_id, "decision": "deny"},
        None,
        None,
        (503, "authentication is unavailable"),
    )


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
    record_get: Callable[[], dict[str, object]],
) -> str:
    """Return one bounded Local assurance outcome without exposing factor material."""
    if kind != "auth:password" or not 1 <= len(secret) <= MAX_AUTH_SECRET_CHARS:
        return "unavailable"
    try:
        record = record_get()
        verified = await asyncio.to_thread(
            auth.verify_password,
            secret,
            record,
        )
    except auth.PasswordRecordError, TypeError, ValueError, RuntimeError, OSError:
        log.warning("Action password authority is unavailable")
        return "unavailable"
    return "verified" if verified else "denied"


def project(body: object, team_id: str) -> dict[str, object]:
    """Return one immutable-ready public challenge or fail without reflecting input."""
    if not isinstance(body, dict) or set(body) - PRESENTATION_FIELDS != RESPONSE_FIELDS:
        raise HumanChallengeError("invalid human challenge envelope")
    if body["team_id"] != team_id or body["status"] != "human-required":
        raise HumanChallengeError("invalid human challenge identity")
    identity = chat_ws_common.challenge_identity(body, team_id)
    if identity is None or not team.is_trace_id(body["trace_id"]):
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
        **_localization(body, request),
        **_presentation(body, request),
    }


def _localization(body: dict[str, object], request: dict[str, object]) -> dict[str, object]:
    """The display copy of exactly the request's references, its concrete locale, and the pack (ADR-0091)."""
    rendered = team_challenge.canonical_rendered(body["rendered"], request)
    locale = team_contract.canonical_locale(body["locale"])
    pack_digest = team_contract.canonical_pack_digest(body["pack_digest"])
    if rendered is None or locale is None or pack_digest is None:
        raise HumanChallengeError("invalid human challenge localization")
    return {"rendered": rendered, "locale": locale, "pack_digest": pack_digest}


def _presentation(body: dict[str, object], request: dict[str, object]) -> dict[str, object]:
    """The optional Brain-written purpose, a Stored Input request's help, and an authorization's file disclosure."""
    presentation: dict[str, object] = {}
    if "purpose" in body:
        purpose = team_contract.canonical_purpose(body["purpose"])
        if purpose is None:
            raise HumanChallengeError("invalid human challenge purpose")
        presentation["purpose"] = purpose
    # A Stored Input request always carries its help text and help link; any other request carries neither.
    stored = request["kind"] == "input:password" and "stored_input" in request
    if stored:
        help_text = team_contract.canonical_stored_input_help(body.get("help"))
        help_url = team_contract.canonical_help_url(body.get("help_url"))
        if help_text is None or help_url is None:
            raise HumanChallengeError("invalid human challenge help")
        presentation.update(help=help_text, help_url=help_url)
    elif "help" in body or "help_url" in body:
        raise HumanChallengeError("invalid human challenge help")
    if "file" in body:
        # The consent names exactly the file whose original bytes the approval delivers; the filename is literal data.
        disclosed = team_challenge.canonical_file_disclosure(body["file"])
        if disclosed is None or request["kind"] not in AUTHORIZATION_KINDS:
            raise HumanChallengeError("invalid human challenge file disclosure")
        presentation["file"] = disclosed
    if "input" in body:
        # Rows of literal escaped text, each cut row flagged and every argument past the last row counted (ADR-0112).
        shown = team_challenge.canonical_input_projection(body["input"])
        if shown is None or request["kind"] not in INPUT_KINDS:
            raise HumanChallengeError("invalid human challenge input")
        presentation["input"] = shown
    elif request["kind"] == CONFIRMATION_KIND:
        # Team's confirmation always shows what it confirms.
        raise HumanChallengeError("invalid human challenge input")
    return presentation


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
        action_id = team.canonical_action_id(value["id"])
        summary = chat_ws_common.public_text(value["summary"], 160)
    except (ValueError, team.TeamRequestError) as exc:
        raise HumanChallengeError("invalid human challenge Action") from exc
    return {"id": action_id, "summary": summary}


def _request(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise HumanChallengeError("invalid human request")
    request = dict(value)
    fingerprint = request.pop("fingerprint", None)
    if (
        not isinstance(fingerprint, str)
        or team_contract.SHA256_RE.fullmatch(fingerprint) is None
        or not _fingerprint(request, fingerprint)
    ):
        raise HumanChallengeError("invalid human request fingerprint")
    kind = request.get("kind")
    ordinal = request.get("ordinal")
    if (
        not isinstance(kind, str)
        or type(ordinal) is not int
        or not 0 <= ordinal < MAX_REQUESTS_PER_ACTION
        or not (_confirmation(request) if kind == CONFIRMATION_KIND else _assistant_request(request, kind))
    ):
        raise HumanChallengeError("invalid human request")
    return {**request, "fingerprint": fingerprint}


def _confirmation(request: dict[str, object]) -> bool:
    """Team's policy confirmation: ordinal 0, its policy, and the lowercase SHA-256 of the call it binds."""
    binding = request.get("binding")
    return (
        set(request) == _CONFIRMATION_FIELDS
        and request["ordinal"] == 0
        and request["policy"] == CONFIRMATION_POLICY
        and isinstance(binding, str)
        and team_contract.SHA256_RE.fullmatch(binding) is not None
    )


def _assistant_request(request: dict[str, object], kind: str) -> bool:
    return _reference(request.get("title")) and _reference(request.get("description")) and _kind(request, kind)


def _kind(request: dict[str, object], kind: str) -> bool:
    fields = set(request)
    base = _BASE_FIELDS - {"fingerprint"}
    if kind == "approval" or kind in AUTH_KINDS:
        return fields == base
    if kind in LENGTH_KINDS:
        expected = base | {"label", "required", "placeholder", "min_length", "max_length"}
        if kind == "input:password":
            # A password always names the Stored Input Team keeps it as (ADR-0106).
            if not _stored_input(request.get("stored_input")):
                return False
            expected |= {"stored_input"}
        return fields == expected and _length(request, LENGTH_KINDS[kind])
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


# Team names a persistent password Stored Input with its exact identifier grammar (ADR-0059, ADR-0106).
def _stored_input(value: object) -> bool:
    return team_contract.canonical_identifier(value) is not None


def _length(request: dict[str, object], limit: int) -> bool:
    minimum = request.get("min_length")
    maximum = request.get("max_length")
    placeholder = request.get("placeholder")
    return (
        _input_base(request)
        and (placeholder is None or _reference(placeholder))
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
    return type(request.get("required")) is bool and _reference(request.get("label"))


def _option(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"value", "label", "description"}
        and _text(value.get("value"), 128)
        and _reference(value.get("label"))
        and (value.get("description") is None or _reference(value.get("description")))
    )


def _reference(value: object) -> bool:
    """One closed `{message, params}` catalog reference with bounded integer, DNS name, or identifier parameters."""
    if not isinstance(value, dict) or set(value) != {"message", "params"}:
        return False
    message = value["message"]
    params = value["params"]
    return (
        isinstance(message, str)
        and _MESSAGE_ID.fullmatch(message) is not None
        and isinstance(params, dict)
        and len(params) <= MAX_REFERENCE_PARAMS
        and all(_PARAM_NAME.fullmatch(name) is not None and _param(item) for name, item in params.items())
    )


def _param(value: object) -> bool:
    if type(value) is int:
        return 0 <= value < MAX_INTEGER_PARAM
    return isinstance(value, str) and (
        (len(value) <= MAX_DNS_NAME_PARAM_CHARS and _DNS_NAME_PARAM.fullmatch(value) is not None)
        or (len(value) <= MAX_IDENTIFIER_PARAM_CHARS and _IDENTIFIER_PARAM.fullmatch(value) is not None)
    )


def _text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and value == value.strip() and 0 < len(value) <= maximum and value.isprintable()


def _fingerprint(request: dict[str, object], supplied: str) -> bool:
    # Exactly the lowercase ASCII hex SHA-256 of the canonical request; anything else never reaches compare_digest.
    if team_contract.SHA256_RE.fullmatch(supplied) is None:
        return False
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


def browser_value(request: object, value: object) -> bool:
    """Validate a browser response against the exact already-projected request descriptor."""
    valid = False
    if isinstance(request, dict):
        kind = request.get("kind")
        if kind in {"approval", CONFIRMATION_KIND}:
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
