"""Local Supervisor setup, MFA login, and passkey-management ceremonies."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import auth
import state
import supervisor
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from mfa import passkeys, tickets, totp

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
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="content type must be application/json")
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > MAX_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body is too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid content length") from None
    body = await request.body()
    if not body or len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=400 if not body else 413, detail="invalid request body")
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid JSON body") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be an object")
    return payload


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


def _ticket(request: Request, context: Context, purpose: str) -> tuple[str, tickets.Ticket]:
    token = request.cookies.get(TICKET_COOKIE, "")
    try:
        ticket = context.ticket_store.consume(token, purpose)
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
        transition = state.bind_browser_origin(external)
        if transition != "unchanged":
            log.info("Local Admin browser origin %s after MFA", transition)


def _complete_totp(code: object, *, enrollment: bool) -> None:
    result = state.verify_totp(code, enrollment=enrollment)
    if result is totp.Verification.LOCKED:
        raise HTTPException(status_code=429, detail="verification code is temporarily locked")
    if result is totp.Verification.EXPIRED:
        raise HTTPException(status_code=409, detail="TOTP enrollment expired; enter the password again")
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
    _complete_totp(payload["code"], enrollment=True)
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
    _token, ticket = _ticket(request, context, "login")
    _complete_totp(payload["code"], enrollment=False)
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
    try:
        challenge = context.challenge_store.consume(token, "authentication")
        if challenge.generation != ticket.generation or challenge.origin != ticket.origin:
            raise passkeys.PasskeyConflictError("authentication factors changed; retry")
        identifier = passkeys.credential_id(payload["credential"])
        original = state.passkey_for_authentication(identifier, challenge.origin)
        verified = passkeys.verify_authentication(challenge, payload["credential"], original)
        secret, suspension_reason = state.commit_passkey_authentication(
            original,
            verified,
            ticket.generation,
            now=int(time.time()),
        )
    except passkeys.PasskeyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except passkeys.PasskeyUnavailableError:
        raise HTTPException(status_code=401, detail="invalid passkey authentication") from None
    if suspension_reason is not None:
        context.factor_changed()
        log.warning("Local Supervisor passkey suspended: %s", suspension_reason)
        raise HTTPException(status_code=401, detail="passkey was suspended; enter the password and use TOTP")
    _bind_origin(ticket.origin)
    response = _response({"ok": True, "method": "passkey"})
    _set_session(response, secret, "webauthn", ticket.origin)
    log.info("Local Supervisor login completed with a passkey")
    return response


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
