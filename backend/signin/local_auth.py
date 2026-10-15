"""Local Supervisor setup, MFA login, passkey-management, and operation-confirmation ceremonies."""

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import cast

import browser
import request_body
import state
import supervisor
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from mfa import passkeys, recovery, tickets, totp
from signin import audit, auth
from space import supervisor_key
from team import http as team_http

from protocol.http.v1.websocket import canonical_origin

log = logging.getLogger("shimpz-admin")

SESSION_COOKIE = "shimpz_admin"
TICKET_COOKIE = "shimpz_admin_ticket"
MAX_BODY_BYTES = 8 * 1024
PASSKEY_ENROLLMENT_FRESH_SECONDS = 5 * 60
FACTORS_CHANGED = "authentication factors changed; enter the password again"
RECOVERY_CODES_SUBJECT = "recovery-codes"
SUPERVISOR_KEY_SUBJECT = "supervisor-key"


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
    if origin in browser.STATIC_ORIGINS or origin.startswith("https://"):
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


async def check_password(password: object, context: Context, origin: str | None = None) -> dict:
    """The Supervisor store record once the password passes sign-in's limiter and lockout; every refusal journaled."""
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
        audit.record("password-locked", outcome="denied", origin=origin)
        raise HTTPException(
            status_code=429,
            detail="too many login attempts",
            headers={"Retry-After": str(lock_seconds)},
        )
    if not accepted:
        log.info("Local Supervisor password rejected")
        audit.record("password-rejected", outcome="denied", origin=origin)
        raise HTTPException(status_code=401, detail="invalid Supervisor credentials")
    return record


async def recheck_password(origin: str | None, password: object, context: Context) -> None:
    """Confirm the password for a session-held destructive operation within the same budget and lockout as sign-in.

    A session holder therefore guesses no faster here than at login; every refusal is journaled the same way, with the
    Origin of the page that asked.
    """
    try:
        await check_password(password, context, origin)
    except HTTPException as exc:
        if exc.status_code == 401:
            raise HTTPException(status_code=403, detail="Supervisor password is incorrect") from None
        raise


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
        if (current := state.browser_origin()) != external:
            audit.record("origin-learned" if current is None else "origin-replaced", outcome="ok", origin=external)
        # Log only constant messages: the transition is read back from the shared state transaction, never logged.
        transition = state.bind_browser_origin(external)
        if transition == "learned":
            log.info("Local Admin browser origin learned after MFA")
        elif transition == "replaced":
            log.info("Local Admin browser origin replaced after MFA")


def _complete_totp(
    code: object,
    *,
    ceremony: str,
    generation: int,
    origin: str | None,
    accepted: str,
    codes: recovery.CodeSet | None = None,
) -> None:
    """Verify one code, journaling its outcome (`accepted` names a success) before the attempt is persisted."""

    def journal(result: object) -> None:
        if result is totp.Verification.ACCEPTED:
            audit.record(accepted, outcome="ok", origin=origin, method="totp")
        elif result is totp.Verification.LOCKED:
            audit.record("totp-locked", outcome="denied", origin=origin)
        elif result is totp.Verification.INVALID:
            audit.record("totp-rejected", outcome="denied", origin=origin)

    result = state.verify_totp(
        code,
        ceremony=ceremony,
        generation=generation,
        codes=None if codes is None else codes.record,
        journal=journal,
    )
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
    payload = request_body.exact_fields(await _json_object(request), "password")
    origin = _request_origin(request)
    current = state.authentication_state()
    if current in {auth.RECORD_STATE_CONFIGURED, auth.RECORD_STATE_RECOVERY_ENROLLMENT}:
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
        audit.record("setup-started", outcome="ok", origin=origin)
        enrollment = await asyncio.to_thread(state.begin_supervisor_setup, password)
        await asyncio.to_thread(supervisor.materialize_public_key, state.local_supervisor())
    else:
        await check_password(payload["password"], context, origin)
        enrollment = state.resume_totp_enrollment()
    generation = state.factor_generation()
    token = context.ticket_store.issue("totp-enrollment", origin, generation)
    response = _response({"enrollment": {"secret": enrollment.secret, "uri": enrollment.uri}}, 202)
    _set_ticket(response, token, origin)
    return response


async def confirm_setup(request: Request, context: Context) -> JSONResponse:
    """Activate TOTP and issue the first MFA session."""
    payload = request_body.exact_fields(await _json_object(request), "code")
    _token, ticket = _ticket(request, context, "totp-enrollment")
    response = await _complete_enrollment(payload["code"], ticket, context, "setup", "setup-completed")
    log.info("Local Supervisor MFA enrollment completed")
    return response


async def _complete_enrollment(
    code: object, ticket: tickets.Ticket, context: Context, ceremony: str, accepted: str
) -> JSONResponse:
    """Activate the pending TOTP with a fresh recovery set, sign in, and show the set's codes this one time."""
    codes = await asyncio.to_thread(recovery.new_set)
    _complete_totp(
        code, ceremony=ceremony, generation=ticket.generation, origin=ticket.origin, accepted=accepted, codes=codes
    )
    _bind_origin(ticket.origin)
    context.factor_changed()
    response = _response({"ok": True, "method": "totp", "recovery_codes": list(codes.codes)})
    _set_session(response, state.get()["session_secret"], "totp", ticket.origin)
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
    payload = request_body.exact_fields(await _json_object(request), "password")
    current = state.authentication_state()
    if current not in {auth.RECORD_STATE_CONFIGURED, auth.RECORD_STATE_RECOVERY_ENROLLMENT}:
        raise HTTPException(status_code=409, detail="Local Supervisor MFA setup is incomplete")
    origin = _request_origin(request)
    await check_password(payload["password"], context, origin)
    generation = state.factor_generation()
    token = context.ticket_store.issue("login", origin, generation)
    # While a recovery code's re-enrollment is open, only another recovery code can begin it again.
    body: dict[str, object] = {"methods": ["recovery-code"]}
    if current == auth.RECORD_STATE_CONFIGURED:
        options = _login_passkey_options(token, origin, generation, context)
        body["methods"] = ["totp", "recovery-code"]
        if options is not None:
            body["methods"] = ["totp", "passkey", "recovery-code"]
            body["passkey_options"] = options
    response = _response(body, 202)
    _set_ticket(response, token, origin)
    return response


async def confirm_login_totp(request: Request, context: Context) -> JSONResponse:
    """Consume one password ticket and complete login with TOTP."""
    payload = request_body.exact_fields(await _json_object(request), "code")
    token, ticket = _ticket(request, context, "login")
    _discard_challenge(token, context)
    try:
        _complete_totp(
            payload["code"], ceremony="login", generation=ticket.generation, origin=ticket.origin, accepted="login"
        )
    except totp.TotpStateError:
        # TOTP is no longer what the ticket was issued for: a recovery code replaced it, and only re-enrollment remains.
        raise HTTPException(status_code=409, detail=FACTORS_CHANGED) from None
    _bind_origin(ticket.origin)
    response = _response({"ok": True, "method": "totp"})
    _set_session(response, state.get()["session_secret"], "totp", ticket.origin)
    log.info("Local Supervisor login completed with TOTP")
    return response


async def confirm_login_passkey(request: Request, context: Context) -> JSONResponse:
    """Consume one password ticket and complete login with an exact-origin UV assertion."""
    payload = request_body.exact_fields(await _json_object(request), "credential")
    token, ticket = _ticket(request, context, "login")
    secret, suspension_reason = _passkey_assertion(token, ticket, payload["credential"], context, "login")
    if suspension_reason is not None:
        _suspended(suspension_reason, context)
        raise HTTPException(status_code=401, detail="passkey was suspended; enter the password and use TOTP")
    _bind_origin(ticket.origin)
    response = _response({"ok": True, "method": "passkey"})
    _set_session(response, secret, "webauthn", ticket.origin)
    log.info("Local Supervisor login completed with a passkey")
    return response


async def confirm_login_recovery(request: Request, context: Context) -> JSONResponse:
    """Spend one password ticket and one recovery code; admit only the re-enrollment of TOTP, never a session."""
    payload = request_body.exact_fields(await _json_object(request), "code")
    token, ticket = _ticket(request, context, "login")
    _discard_challenge(token, context)
    try:
        derived = await asyncio.to_thread(state.recovery_candidate, payload["code"])
    except totp.TotpStateError:
        raise HTTPException(status_code=409, detail=FACTORS_CHANGED) from None

    def journal(outcome: object) -> None:
        result = cast(tuple[totp.Verification, object], outcome)[0]
        if result is totp.Verification.ACCEPTED:
            audit.record("recovery-code-used", outcome="ok", origin=ticket.origin, method="recovery-code")
        elif result is totp.Verification.LOCKED:
            audit.record("recovery-code-locked", outcome="denied", origin=ticket.origin)
        else:
            audit.record("recovery-code-rejected", outcome="denied", origin=ticket.origin)

    result, enrollment = state.spend_recovery_code(derived, generation=ticket.generation, journal=journal)
    if result is totp.Verification.LOCKED:
        raise HTTPException(status_code=429, detail="verification code is temporarily locked")
    if result is totp.Verification.CHANGED:
        raise HTTPException(status_code=409, detail=FACTORS_CHANGED)
    if enrollment is None:
        raise HTTPException(status_code=401, detail="invalid recovery code")
    # Every session ended with the old factor; the re-enrollment is this browser's own, bound to the new generation.
    context.factor_changed()
    log.warning("Local Supervisor recovery code used; TOTP re-enrollment is required")
    reenrollment = context.ticket_store.issue("recovery-enrollment", ticket.origin, state.factor_generation())
    response = _response({"enrollment": {"secret": enrollment.secret, "uri": enrollment.uri}}, 202)
    _set_ticket(response, reenrollment, ticket.origin)
    return response


async def confirm_recovery_enrollment(request: Request, context: Context) -> JSONResponse:
    """Complete the TOTP re-enrollment a recovery code began, issuing the session and a fresh set of codes."""
    payload = request_body.exact_fields(await _json_object(request), "code")
    _token, ticket = _ticket(request, context, "recovery-enrollment")
    try:
        response = await _complete_enrollment(payload["code"], ticket, context, "recovery", "recovery-completed")
    except HTTPException as exc:
        if exc.status_code != 401:
            raise
        # A mistyped code costs no further recovery code: the same browser gets a fresh ticket for the next code, and
        # the pending factor's own failure budget bounds the attempts.
        refused = _response({"detail": exc.detail}, 401)
        _set_ticket(
            refused, context.ticket_store.issue("recovery-enrollment", ticket.origin, ticket.generation), ticket.origin
        )
        return refused
    log.info("Local Supervisor TOTP re-enrollment completed")
    return response


def _discard_challenge(token: str, context: Context) -> None:
    """A ceremony completed with TOTP leaves no passkey challenge behind."""
    with contextlib.suppress(passkeys.PasskeyError):
        context.challenge_store.consume(token, "authentication")


def _passkey_assertion(
    token: str, ticket: tickets.Ticket, credential: object, context: Context, accepted: str
) -> tuple[str, str | None]:
    """Verify one UV assertion against the ticket's own challenge and commit it, or raise its closed outcome.

    The commit journals a suspension, or the success named by `accepted`, before the credential's update is persisted.
    """

    def journal(result: object) -> None:
        if cast(tuple[str, str | None], result)[1] is not None:
            audit.record("passkey-suspended", outcome="denied", origin=ticket.origin)
        else:
            audit.record(accepted, outcome="ok", origin=ticket.origin, method="passkey")

    try:
        challenge = context.challenge_store.consume(token, "authentication")
        if challenge.generation != ticket.generation or challenge.origin != ticket.origin:
            raise passkeys.PasskeyConflictError("authentication factors changed; retry")
        identifier = passkeys.credential_id(credential)
        original = state.passkey_for_authentication(identifier, challenge.origin)
        verified = passkeys.verify_authentication(challenge, credential, original)
        return state.commit_passkey_authentication(
            original, verified, ticket.generation, now=int(time.time()), sign_in=accepted == "login", journal=journal
        )
    except passkeys.PasskeyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except passkeys.PasskeyUnavailableError:
        audit.record("passkey-rejected", outcome="denied", origin=ticket.origin)
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
    return origin in browser.STATIC_ORIGINS or origin == state.browser_origin()


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
    # Freshness is the sign-in's own time, never an inference from when the session would expire.
    if evidence is None or time.time() - evidence.issued_at > PASSKEY_ENROLLMENT_FRESH_SECONDS:
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
    payload = request_body.exact_fields(await _json_object(request), "credential")
    origin = _request_origin(request)
    if not passkey_enrollment_available(origin):
        raise HTTPException(status_code=409, detail="passkeys are unavailable at this Admin address")
    session_token = request.cookies.get(SESSION_COOKIE, "")
    try:
        challenge = context.challenge_store.consume(session_token, "registration")
        if challenge.origin != origin or challenge.generation != state.factor_generation():
            raise passkeys.PasskeyConflictError("authentication factors changed; retry")
        record = passkeys.verify_registration(challenge, payload["credential"], int(time.time()))
        secret = state.add_passkey(
            record,
            challenge.generation,
            journal=lambda _secret: audit.record("passkey-registered", outcome="ok", origin=origin),
        )
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


def operation_refusal(error: OperationRefusedError) -> tuple[int, dict[str, object]]:
    """The page's view of a refusal: its status, its code and, for a lockout, when to try again."""
    body: dict[str, object] = {"code": error.code}
    if error.retry_after:
        body["retry_after"] = error.retry_after
    return error.status, body


@dataclass(frozen=True, slots=True)
class Asker:
    """Who asks for a confirmed operation: the session socket's bound Origin, its session, and its ticket binding.

    A ticket issued to the asker is bound to that one socket and session (ADR-0114 decision 6) beside every binding an
    operation ticket already has, and the socket keeps it: the page never holds it.
    """

    origin: str | None
    session: str = field(repr=False)
    binding: tickets.Binding


def _operation_origin(origin: str | None) -> str:
    """An operation is confirmed only from a browser origin Admin already admits, never one it would learn."""
    if origin is None or (origin not in browser.STATIC_ORIGINS and origin != state.browser_origin()):
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


def operation_password(payload: dict) -> object:
    """The one password a confirmation starts with; any other body is the request's own 400."""
    return request_body.exact_fields(payload, "password")["password"]


async def verify_operation_password(asker: Asker, context: Context, password: object) -> None:
    """Verify the password one exact operation starts with, as login does, within sign-in's limiter (ADR-0051)."""
    try:
        origin = _operation_origin(asker.origin)
        if state.authentication_state() != auth.RECORD_STATE_CONFIGURED:
            raise OperationRefusedError(409, "authentication-unavailable")
        await check_password(password, context, origin)
    except HTTPException as exc:
        if exc.status_code == 429:
            retry_after = int((exc.headers or {}).get("Retry-After", "1"))
            raise OperationRefusedError(429, "authentication-locked", retry_after) from None
        raise OperationRefusedError(401, "password-incorrect") from None
    except _STATE_FAILURES:
        raise _unavailable() from None


def offer_operation(asker: Asker, context: Context, subject: str) -> tuple[dict[str, object], str]:
    """After the password, offer the operation's second factor: the offer, and the ticket the asker's socket keeps."""
    try:
        origin = _operation_origin(asker.origin)
        generation = state.factor_generation()
        token = context.ticket_store.issue("operation", origin, generation, subject, asker.binding)
    except (tickets.TicketError, *_STATE_FAILURES):
        raise _unavailable() from None
    try:
        return _operation_offer(token, origin, generation, context), token
    except _STATE_FAILURES:
        # The offer could not be made, so its ticket and any passkey challenge are spent before anyone could hold them.
        discard_operation(token, context)
        raise _unavailable() from None


def discard_operation(token: str, context: Context) -> None:
    """Spend a pending operation ticket nobody will complete, and its passkey challenge with it."""
    if not token:
        return
    with contextlib.suppress(tickets.TicketError):
        context.ticket_store.consume(token, "operation")
    _discard_challenge(token, context)


def operation_factor(payload: dict) -> tuple[str, object]:
    """The one second factor a confirmation is completed with; any other body is the request's own 400."""
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
            _complete_totp(
                value,
                ceremony="operation",
                generation=ticket.generation,
                origin=ticket.origin,
                accepted="operation-confirmed",
            )
            return
        _secret, suspension_reason = _passkey_assertion(token, ticket, value, context, "operation-confirmed")
    except HTTPException as exc:
        raise OperationRefusedError(*refusals.get(exc.status_code, (503, "authentication-unavailable"))) from None
    if suspension_reason is not None:
        _suspended(suspension_reason, context)
        raise OperationRefusedError(401, "passkey-suspended")


@dataclass(frozen=True, slots=True)
class Confirmation:
    """One completion of a confirmed operation: the ticket its asker's socket kept and the second factor offered."""

    token: str = field(repr=False)
    method: str
    value: object = field(repr=False)


def _confirmed(
    asker: Asker, context: Context, subject: str, confirmation: Confirmation, current: Callable[[], bool]
) -> None:
    _operation_origin(asker.origin)
    try:
        ticket = context.ticket_store.consume(confirmation.token, "operation", subject, asker.binding)
    except tickets.TicketError:
        raise OperationRefusedError(401, "authentication-expired") from None
    if ticket.origin != asker.origin or state.factor_generation() != ticket.generation:
        raise OperationRefusedError(401, "authentication-expired")
    _operation_second_factor(confirmation.method, confirmation.value, confirmation.token, ticket, context)
    session = auth.verify_session(state.get().get("session_secret", ""), asker.session)
    if session is None or not current():
        raise OperationRefusedError(401, "authentication-expired")


def confirm_operation[T](
    asker: Asker,
    context: Context,
    subject: str,
    confirmation: Confirmation,
    current: Callable[[], bool],
    dispatch: Callable[[], T],
) -> T:
    """Spend the operation's one ticket on exactly one second factor, then dispatch the operation, or raise a refusal.

    Nothing here issues a session or learns a browser origin. The asker's session, and with `current` its socket and
    the socket's Origin, are rechecked after the factor and immediately before `dispatch`, in this same call, so a
    session revoked or a socket closed meanwhile never reaches the operation.
    """
    try:
        _confirmed(asker, context, subject, confirmation, current)
    except (OperationRefusedError, *_STATE_FAILURES) as exc:
        # A refused or failed completion spends the ticket's passkey challenge too, which nothing can use any more.
        _discard_challenge(confirmation.token, context)
        if isinstance(exc, OperationRefusedError):
            raise
        raise _unavailable() from None
    log.info("Supervisor operation confirmed with %s", "TOTP" if confirmation.method == "totp" else "a passkey")
    return dispatch()


def regenerate_recovery_codes(origin: str | None, context: Context) -> tuple[int, dict[str, object]]:
    """Replace every recovery code once the operation's second factor confirmed it, returning the new set once.

    Run on a worker thread: the set's ten derivations block.
    """
    codes = recovery.new_set()
    state.replace_recovery_codes(
        codes.record,
        journal=lambda _result: audit.record("recovery-codes-generated", outcome="ok", origin=origin),
    )
    context.factor_changed()
    log.info("Local Supervisor recovery codes replaced")
    return 200, {"recovery_codes": list(codes.codes)}


# How a rotation ended, as the browser reads it: Team pins the new key, kept the current one, or has not answered yet.
_ROTATION_ANSWERS = {
    supervisor_key.Outcome.ROTATED: (200, {"rotated": True}),
    supervisor_key.Outcome.ABANDONED: (409, {"code": "supervisor-key-rotation-refused"}),
    supervisor_key.Outcome.PENDING: (503, {"code": "supervisor-key-rotation-pending"}),
}


def rotate_supervisor_key(
    asker: Asker, recovery_retry: supervisor_key.Recovery | None
) -> tuple[int, dict[str, object]]:
    """Replace the Supervisor's signing key once the operation's second factor confirmed it (ADR-0051).

    Run on a worker thread: Team's answers block. A rotation Team has not answered yet stays open and is retried in
    the background.
    """
    try:
        outcome = supervisor_key.rotate(asker.session, asker.origin)
    except state.SupervisorKeyRotationError:
        return 409, {"code": "supervisor-key-rotation-busy"}
    except (*_STATE_FAILURES, audit.AuditUnavailableError):
        log.warning("Local Supervisor key rotation is unavailable")
        return 503, {"code": "supervisor-key-unavailable"}
    if outcome is supervisor_key.Outcome.PENDING and recovery_retry is not None:
        recovery_retry.wake()
    return _ROTATION_ANSWERS[outcome]
