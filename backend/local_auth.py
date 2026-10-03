"""Local Supervisor setup, MFA login, passkey-management, and operation-confirmation ceremonies."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import auth
import state
import supervisor
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from mfa import passkeys, tickets, totp
from team import http as team_http

from chat import socket as chat_socket
from protocol.http.v1.websocket import canonical_origin

log = logging.getLogger("shimpz-admin")

SESSION_COOKIE = "shimpz_admin"
TICKET_COOKIE = "shimpz_admin_ticket"
MAX_BODY_BYTES = 8 * 1024
PASSKEY_ENROLLMENT_FRESH_SECONDS = 5 * 60


@dataclass(slots=True)
class Context:
    """Process-local bounded ceremony authorities for the single Admin process."""

    limiter: auth.LocalLoginLimiter = field(default_factory=auth.LocalLoginLimiter)
    ticket_store: tickets.TicketStore = field(default_factory=tickets.TicketStore)
    challenge_store: passkeys.ChallengeStore = field(default_factory=passkeys.ChallengeStore)

    def factor_changed(self) -> None:
        self.ticket_store.clear()
        self.challenge_store.clear()


async def _json_object(request: Request) -> dict:
    return await team_http.bounded_json_object(request, MAX_BODY_BYTES)


def _request_origin(request: Request) -> str | None:
    raw = request.headers.get("origin")
    if raw is None:
        return None
    origin = canonical_origin(raw)
    if origin is None or origin != raw:
        raise HTTPException(status_code=403, detail="request Origin is invalid")
    if origin in chat_socket.STATIC_ORIGINS or origin.startswith("https://"):
        return origin
    raise HTTPException(status_code=403, detail="request Origin is not admitted")


def _external_origin(origin: str | None) -> str | None:
    return origin if origin is not None and origin.startswith("https://") else None


def _same_origin(request: Request, expected: str | None) -> None:
    if _request_origin(request) != expected:
        raise HTTPException(status_code=403, detail="authentication ceremony origin changed")


def _response(body: dict[str, object], status: int = 200) -> JSONResponse:
    response = JSONResponse(body, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    return response


def _set_ticket(response: JSONResponse, token: str, origin: str | None) -> None:
    response.set_cookie(
        TICKET_COOKIE,
        token,
        max_age=tickets.TICKET_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        secure=origin is not None and origin.startswith("https://"),
        path="/api/",
    )


def _set_session(response: JSONResponse, secret: str, method: str, origin: str | None) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        auth.issue_session(secret, method),
        max_age=auth.TTL,
        httponly=True,
        samesite="strict",
        secure=origin is not None and origin.startswith("https://"),
        path="/",
    )
    response.delete_cookie(TICKET_COOKIE, path="/api/")


async def _verify_password(password: object, context: Context) -> dict:
    if not isinstance(password, str) or not 1 <= len(password) <= auth.MAX_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="invalid Supervisor credentials")
    record = state.get()
    try:
        accepted, lock_seconds = await auth.attempt_login(password, record, context.limiter)
    except auth.LoginRateLimitedError as exc:
        raise HTTPException(
            status_code=429,
            detail="too many login attempts",
            headers={"Retry-After": str(exc.retry_after)},
        ) from None
    if lock_seconds:
        log.info("Local login locked after repeated password rejection")
        raise HTTPException(
            status_code=429,
            detail="too many login attempts",
            headers={"Retry-After": str(lock_seconds)},
        )
    if not accepted:
        log.info("Local Supervisor password rejected")
        raise HTTPException(status_code=401, detail="invalid Supervisor credentials")
    return record


def _ticket(request: Request, context: Context, purpose: str, subject: str = "") -> tuple[str, tickets.Ticket]:
    token = request.cookies.get(TICKET_COOKIE, "")
    try:
        ticket = context.ticket_store.consume(token, purpose, subject)
    except tickets.TicketError:
        raise HTTPException(
            status_code=401,
            detail="authentication ceremony expired; enter the password again",
        ) from None
    _same_origin(request, ticket.origin)
    if state.factor_generation() != ticket.generation:
        raise HTTPException(status_code=409, detail="authentication factors changed; enter the password again")
    return token, ticket


def _bind_origin(origin: str | None) -> None:
    if external := _external_origin(origin):
        # Log only constant messages: the transition is read back from the shared state transaction, never logged.
        transition = state.bind_browser_origin(external)
        if transition == "learned":
            log.info("Local Admin browser origin learned after MFA")
        elif transition == "replaced":
            log.info("Local Admin browser origin replaced after MFA")


def _complete_totp(code: object, *, enrollment: bool, generation: int) -> None:
    result = state.verify_totp(code, enrollment=enrollment, generation=generation)
    if result is totp.Verification.LOCKED:
        raise HTTPException(status_code=429, detail="verification code is temporarily locked")
    if result is totp.Verification.EXPIRED:
        raise HTTPException(status_code=409, detail="TOTP enrollment expired; enter the password again")
    if result is totp.Verification.CHANGED:
        raise HTTPException(status_code=409, detail="authentication factors changed; enter the password again")
    if result is not totp.Verification.ACCEPTED:
        raise HTTPException(status_code=401, detail="invalid verification code")


async def setup(request: Request, context: Context) -> JSONResponse:
    """Create or resume the password-bound mandatory TOTP enrollment."""
    payload = await _json_object(request)
    if set(payload) != {"password"}:
        raise HTTPException(status_code=400, detail="request body must contain only password")
    origin = _request_origin(request)
    current = state.authentication_state()
    if current == auth.RECORD_STATE_CONFIGURED:
        raise HTTPException(status_code=409, detail="Local Supervisor authentication is already configured")
    if current == auth.RECORD_STATE_UNINITIALIZED:
        password = payload["password"]
        if not isinstance(password, str):
            raise HTTPException(status_code=400, detail="request body must contain only password")
        if violation := auth.password_policy(password):
            details = {
                "password-too-short": f"password must be at least {auth.MIN_PASSWORD_CHARS} characters",
                "password-too-long": "password is too long",
                "password-blocklisted": "choose a password that is not commonly used or expected",
            }
            return _response({"code": violation, "detail": details[violation]}, 400)
        enrollment = await asyncio.to_thread(state.begin_supervisor_setup, password)
        await asyncio.to_thread(supervisor.materialize_public_key, state.local_supervisor())
    else:
        await _verify_password(payload["password"], context)
        enrollment = state.resume_totp_enrollment()
    generation = state.factor_generation()
    token = context.ticket_store.issue("totp-enrollment", origin, generation)
    response = _response({"enrollment": {"secret": enrollment.secret, "uri": enrollment.uri}}, 202)
    _set_ticket(response, token, origin)
    return response


async def confirm_setup(request: Request, context: Context) -> JSONResponse:
    """Activate TOTP and issue the first MFA session."""
    payload = await _json_object(request)
    if set(payload) != {"code"}:
        raise HTTPException(status_code=400, detail="request body must contain only code")
    _token, ticket = _ticket(request, context, "totp-enrollment")
    _complete_totp(payload["code"], enrollment=True, generation=ticket.generation)
    _bind_origin(ticket.origin)
    context.factor_changed()
    response = _response({"ok": True, "method": "totp"})
    _set_session(response, state.get()["session_secret"], "totp", ticket.origin)
    log.info("Local Supervisor MFA enrollment completed")
    return response


def _login_passkey_options(token: str, origin: str | None, generation: int, context: Context) -> dict | None:
    if origin is None:
        return None
    try:
        records = state.active_passkeys(origin)
        if not records:
            return None
        challenge = context.challenge_store.issue(token, "authentication", origin, generation)
        return passkeys.authentication_options(challenge, records)
    except passkeys.PasskeyError:
        return None


async def login(request: Request, context: Context) -> JSONResponse:
    """Verify the password and issue only a short-lived second-factor ticket."""
    payload = await _json_object(request)
    if set(payload) != {"password"}:
        raise HTTPException(status_code=400, detail="request body must contain only password")
    if state.authentication_state() != auth.RECORD_STATE_CONFIGURED:
        raise HTTPException(status_code=409, detail="Local Supervisor MFA setup is incomplete")
    origin = _request_origin(request)
    await _verify_password(payload["password"], context)
    generation = state.factor_generation()
    token = context.ticket_store.issue("login", origin, generation)
    options = _login_passkey_options(token, origin, generation, context)
    body: dict[str, object] = {"methods": ["totp"]}
    if options is not None:
        body["methods"] = ["totp", "passkey"]
        body["passkey_options"] = options
    response = _response(body, 202)
    _set_ticket(response, token, origin)
    return response


async def confirm_login_totp(request: Request, context: Context) -> JSONResponse:
    """Consume one password ticket and complete login with TOTP."""
    payload = await _json_object(request)
    if set(payload) != {"code"}:
        raise HTTPException(status_code=400, detail="request body must contain only code")
    token, ticket = _ticket(request, context, "login")
    _discard_challenge(token, context)
    _complete_totp(payload["code"], enrollment=False, generation=ticket.generation)
    _bind_origin(ticket.origin)
    response = _response({"ok": True, "method": "totp"})
    _set_session(response, state.get()["session_secret"], "totp", ticket.origin)
    log.info("Local Supervisor login completed with TOTP")
    return response


async def confirm_login_passkey(request: Request, context: Context) -> JSONResponse:
    """Consume one password ticket and complete login with an exact-origin UV assertion."""
    payload = await _json_object(request)
    if set(payload) != {"credential"}:
        raise HTTPException(status_code=400, detail="request body must contain only credential")
    token, ticket = _ticket(request, context, "login")
    secret, suspension_reason = _passkey_assertion(token, ticket, payload["credential"], context)
    if suspension_reason is not None:
        _suspended(suspension_reason, context)
        raise HTTPException(status_code=401, detail="passkey was suspended; enter the password and use TOTP")
    _bind_origin(ticket.origin)
    response = _response({"ok": True, "method": "passkey"})
    _set_session(response, secret, "webauthn", ticket.origin)
    log.info("Local Supervisor login completed with a passkey")
    return response


def _discard_challenge(token: str, context: Context) -> None:
    """A ceremony completed with TOTP leaves no passkey challenge behind."""
    with contextlib.suppress(passkeys.PasskeyError):
        context.challenge_store.consume(token, "authentication")


def _passkey_assertion(
    token: str, ticket: tickets.Ticket, credential: object, context: Context
) -> tuple[str, str | None]:
    """Verify one UV assertion against the ticket's own challenge and commit it, or raise its closed outcome."""
    try:
        challenge = context.challenge_store.consume(token, "authentication")
        if challenge.generation != ticket.generation or challenge.origin != ticket.origin:
            raise passkeys.PasskeyConflictError("authentication factors changed; retry")
        identifier = passkeys.credential_id(credential)
        original = state.passkey_for_authentication(identifier, challenge.origin)
        verified = passkeys.verify_authentication(challenge, credential, original)
        return state.commit_passkey_authentication(original, verified, ticket.generation, now=int(time.time()))
    except passkeys.PasskeyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except passkeys.PasskeyUnavailableError:
        raise HTTPException(status_code=401, detail="invalid passkey authentication") from None


def _suspended(reason: str, context: Context) -> None:
    context.factor_changed()
    if reason == "counter-regression":
        log.warning("Local Supervisor passkey suspended: counter-regression")
    else:
        log.warning("Local Supervisor passkey suspended: backup-identity-change")


def passkey_enrollment_available(origin: str | None) -> bool:
    """Return whether the authenticated exact origin can host WebAuthn."""
    if origin is None:
        return False
    try:
        passkeys.rp_id_for_origin(origin)
    except passkeys.PasskeyUnavailableError:
        return False
    return origin in chat_socket.STATIC_ORIGINS or origin == state.browser_origin()


def passkey_registered(origin: str | None) -> bool:
    """Return whether this exact WebAuthn origin already has an active credential."""
    if not passkey_enrollment_available(origin):
        return False
    try:
        return bool(state.active_passkeys(origin))
    except passkeys.PasskeyUnavailableError:
        return False


async def begin_passkey_registration(request: Request, context: Context) -> JSONResponse:
    """Start registration from one admitted MFA-authenticated browser origin."""
    payload = await _json_object(request)
    if payload:
        raise HTTPException(status_code=400, detail="request body must be an empty object")
    origin = _request_origin(request)
    if not passkey_enrollment_available(origin):
        raise HTTPException(status_code=409, detail="passkeys are unavailable at this Admin address")
    session_token = request.cookies.get(SESSION_COOKIE, "")
    evidence = auth.verify_session(state.get().get("session_secret", ""), session_token)
    if evidence is None or evidence.expires_at - time.time() < auth.TTL - PASSKEY_ENROLLMENT_FRESH_SECONDS:
        raise HTTPException(status_code=401, detail="fresh multifactor authentication is required")
    try:
        generation = state.factor_generation()
        records = state.passkeys_for_registration(origin)
        challenge = context.challenge_store.issue(session_token, "registration", origin, generation)
        options = passkeys.registration_options(challenge, state.webauthn_user_id(), records)
    except passkeys.PasskeyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return _response({"options": options})


async def complete_passkey_registration(request: Request, context: Context) -> JSONResponse:
    """Persist one verified passkey and rotate every previous Local session."""
    payload = await _json_object(request)
    if set(payload) != {"credential"}:
        raise HTTPException(status_code=400, detail="request body must contain only credential")
    origin = _request_origin(request)
    if not passkey_enrollment_available(origin):
        raise HTTPException(status_code=409, detail="passkeys are unavailable at this Admin address")
    session_token = request.cookies.get(SESSION_COOKIE, "")
    try:
        challenge = context.challenge_store.consume(session_token, "registration")
        if challenge.origin != origin or challenge.generation != state.factor_generation():
            raise passkeys.PasskeyConflictError("authentication factors changed; retry")
        record = passkeys.verify_registration(challenge, payload["credential"], int(time.time()))
        secret = state.add_passkey(record, challenge.generation)
    except passkeys.PasskeyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except passkeys.PasskeyUnavailableError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    context.factor_changed()
    response = _response({"registered": True})
    _set_session(response, secret, "webauthn", origin)
    log.info("Local Supervisor passkey registered")
    return response


class OperationRefusedError(Exception):
    """One closed, secret-free reason a Supervisor operation confirmation was refused."""

    def __init__(self, status: int, code: str, retry_after: int = 0) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def operation_refusal(error: OperationRefusedError) -> JSONResponse:
    """The browser's view of a refusal: its code and, for a lockout, when to try again."""
    body: dict[str, object] = {"code": error.code}
    if error.retry_after:
        body["retry_after"] = error.retry_after
    response = _response(body, error.status)
    if error.retry_after:
        response.headers["Retry-After"] = str(error.retry_after)
    return response


def _operation_origin(request: Request) -> str:
    """An operation is confirmed only from a browser origin Admin already admits, never one it would learn."""
    try:
        origin = _request_origin(request)
    except HTTPException:
        origin = None
    if origin is None or (origin not in chat_socket.STATIC_ORIGINS and origin != state.browser_origin()):
        raise OperationRefusedError(403, "authentication-origin-refused")
    return origin


def _operation_offer(token: str, origin: str, generation: int, context: Context) -> dict[str, object]:
    if not passkey_registered(origin):
        return {"methods": ["totp"]}
    challenge = context.challenge_store.issue(token, "authentication", origin, generation)
    options = passkeys.authentication_options(challenge, state.active_passkeys(origin))
    return {"methods": ["totp", "passkey"], "passkey_options": options}


# What reading or persisting the authentication state can raise; inside a ceremony each fails closed as unavailable.
_STATE_FAILURES = (RuntimeError, ValueError, TypeError, KeyError, OSError)


def _unavailable() -> OperationRefusedError:
    log.warning("Supervisor operation confirmation is unavailable")
    return OperationRefusedError(503, "authentication-unavailable")


async def begin_operation(request: Request, context: Context, subject: str) -> JSONResponse:
    """Verify the password for one exact operation and offer its second factor, as login does (ADR-0051)."""
    payload = await _json_object(request)
    if set(payload) != {"password"}:
        raise HTTPException(status_code=400, detail="request body must contain only password")
    try:
        return await _begin_operation(request, context, subject, payload["password"])
    except _STATE_FAILURES:
        raise _unavailable() from None


async def _begin_operation(request: Request, context: Context, subject: str, password: object) -> JSONResponse:
    origin = _operation_origin(request)
    if state.authentication_state() != auth.RECORD_STATE_CONFIGURED:
        raise OperationRefusedError(409, "authentication-unavailable")
    try:
        await _verify_password(password, context)
    except HTTPException as exc:
        if exc.status_code == 429:
            retry_after = int((exc.headers or {}).get("Retry-After", "1"))
            raise OperationRefusedError(429, "authentication-locked", retry_after) from None
        raise OperationRefusedError(401, "password-incorrect") from None
    generation = state.factor_generation()
    try:
        token = context.ticket_store.issue("operation", origin, generation, subject)
    except tickets.TicketError:
        raise _unavailable() from None
    try:
        body = _operation_offer(token, origin, generation, context)
    except _STATE_FAILURES:
        # The offer could not be made, so its ticket is spent before anyone could hold it.
        with contextlib.suppress(tickets.TicketError):
            context.ticket_store.consume(token, "operation", subject)
        raise _unavailable() from None
    response = _response(body, 202)
    _set_ticket(response, token, origin)
    return response


def _operation_factor(payload: dict) -> tuple[str, object]:
    if set(payload) == {"code"} and isinstance(payload["code"], str):
        return "totp", payload["code"]
    if set(payload) == {"credential"}:
        return "passkey", payload["credential"]
    raise HTTPException(status_code=400, detail="request body must contain only code or credential")


# The login helpers' closed HTTP outcomes, as the operation's refusals: a 409 means the ticket's factors changed.
_TOTP_REFUSALS = {401: (401, "code-incorrect"), 429: (429, "code-locked"), 409: (401, "authentication-expired")}
_PASSKEY_REFUSALS = {401: (401, "passkey-failed"), 409: (401, "authentication-expired")}


def _operation_second_factor(method: str, value: object, token: str, ticket: tickets.Ticket, context: Context) -> None:
    refusals = _TOTP_REFUSALS if method == "totp" else _PASSKEY_REFUSALS
    try:
        if method == "totp":
            _discard_challenge(token, context)
            _complete_totp(value, enrollment=False, generation=ticket.generation)
            return
        _secret, suspension_reason = _passkey_assertion(token, ticket, value, context)
    except HTTPException as exc:
        raise OperationRefusedError(*refusals.get(exc.status_code, (503, "authentication-unavailable"))) from None
    if suspension_reason is not None:
        _suspended(suspension_reason, context)
        raise OperationRefusedError(401, "passkey-suspended")


def _confirmed(request: Request, context: Context, subject: str, method: str, value: object) -> None:
    _operation_origin(request)
    try:
        token, ticket = _ticket(request, context, "operation", subject)
    except HTTPException:
        raise OperationRefusedError(401, "authentication-expired") from None
    _operation_second_factor(method, value, token, ticket, context)
    session = auth.verify_session(state.get().get("session_secret", ""), request.cookies.get(SESSION_COOKIE, ""))
    if session is None:
        raise OperationRefusedError(401, "authentication-expired")


def confirm_operation[T](
    request: Request, context: Context, subject: str, payload: dict, dispatch: Callable[[], T]
) -> T:
    """Spend the operation's one ticket on exactly one second factor, then dispatch the operation, or raise a refusal.

    Nothing here issues a session or learns a browser origin. The request's own session is rechecked after the factor
    and immediately before `dispatch`, in this same call, so a session revoked meanwhile never reaches the operation.
    """
    method, value = _operation_factor(payload)
    try:
        _confirmed(request, context, subject, method, value)
    except _STATE_FAILURES:
        raise _unavailable() from None
    log.info("Supervisor operation confirmed with %s", "TOTP" if method == "totp" else "a passkey")
    return dispatch()
