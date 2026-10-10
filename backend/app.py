"""The Local Admin API and static UI server running in the `shimpz-admin` container.

The Supervisor authenticates with its one separately set password and session. Query parameters
never grant a session.

The static SPA + the auth endpoints are open (the login form carries no secret); every Team,
Assistant, model-provider, OAuth, and chat endpoint requires a valid session. This
process holds no Docker socket and has no host configuration write surface.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager, suppress
from functools import partial
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

sys.path.insert(0, str(Path(__file__).resolve().parent))
import browser
import decision
import models
import state
import supervisor
from history import http as chat_history_http
from signin import audit, auth, local_auth, security
from space import host_reset, supervisor_key
from space import release as platform_release
from space import reset as space_reset
from team import assets as team_assets
from team import bridge as team
from team import files as team_files
from team import http as team_http
from team import inference as team_inference
from team import names as team_names
from team import order as team_order
from team import snapshots as team_snapshots
from team import summary as team_summary

from action import stored_input as action_stored_input
from chat import assets as chat_assets
from chat import human as chat_human
from chat import socket as chat_socket
from integrations import assistants as integrations
from integrations import handoff as handoff_store
from protocol.http.v1 import websocket as chat_ws_common
from routine import http as routine_http
from routine import scheduler as routine_scheduler

log = logging.getLogger("shimpz-admin")
chat_history = chat_history_http.store
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


_AUTHENTICATE_ACTION_REQUEST = chat_human.LocalPasswordAuthority(
    partial(
        chat_human.authenticate_local,
        record_get=state.get,
    )
)
_LOCAL_AUTH_CONTEXT = local_auth.Context()
auth.blocklist()  # a missing password blocklist fails at import, not at the first Supervisor setup
TEAM_CREDENTIALS_ENABLED = os.environ.get("SHIMPZ_TEAM_CREDENTIALS_ENABLED", "1").strip() == "1"

UI_DIR = Path(__file__).resolve().parent.parent / "frontend" / "build"
COOKIE = "shimpz_admin"
OAUTH_COOKIE = "shimpz_oauth_binding"
BACKGROUND_HEADER = "shimpz-activity"
OAUTH_COOKIE_PATH = "/api/oauth/cloudflare"
OAUTH_COOKIE_TTL = 300
OAUTH_START_PATH = "/api/oauth/cloudflare/start"
_OAUTH_CHAT_REDIRECT = partial(
    browser.oauth_chat_redirect,
    cookie_name=OAUTH_COOKIE,
    cookie_path=OAUTH_COOKIE_PATH,
)
_ADMIN_SETUP_LOCK = asyncio.Lock()
OAUTH_ORIGINS = {
    "loopback": "http://127.0.0.1:7777",
    "local-domain": "https://local.shimpz.com",
}
MAX_TEAM_DELETE_BODY_BYTES = 8 * 1024
MAX_PASSWORD_CHARS = auth.MAX_PASSWORD_CHARS
SPA_SCRIPT_SOURCES = browser.spa_script_sources(UI_DIR)

# Open surface: the SPA shell (served for any non-/api path) + these auth endpoints. Everything
# else under /api/ needs a session.
OPEN_API = frozenset(
    {
        "/api/session",
        "/api/login",
        "/api/logout",
        "/api/admin/setup",
        "/api/admin/setup/totp",
        "/api/login/totp",
        "/api/login/passkey",
        "/api/login/recovery",
        "/api/login/recovery/totp",
        "/api/oauth/cloudflare/start",
        "/api/oauth/cloudflare/callback",
        "/api/space/host",
    }
)


@asynccontextmanager
async def _lifespan(application: FastAPI):
    try:
        initialized = state.is_initialized()
    except auth.PasswordRecordError:
        log.exception("Local Supervisor password record requires bounded recovery")
    else:
        if initialized:
            await asyncio.to_thread(_materialize_local_supervisor)
    scheduler = routine_scheduler.RoutineScheduler()
    application.state.routine_scheduler = scheduler
    scheduler.start()
    # A Supervisor key rotation Team had not answered before a restart is settled before anything else needs it.
    recovery = supervisor_key.Recovery()
    application.state.supervisor_key_recovery = recovery
    recovery.start()
    try:
        yield
    finally:
        recovery.close()
        scheduler.close()


app = FastAPI(title="shimpz-admin", docs_url=None, redoc_url=None, openapi_url=None, lifespan=_lifespan)
platform_release.register(app)
routine_http.register(app, _AUTHENTICATE_ACTION_REQUEST, _LOCAL_AUTH_CONTEXT)
team_inference.register(app)
team_assets.register(app)
team_summary.register(app)
security.register(app)
app.add_api_route(
    "/api/assistant-catalog",
    chat_assets.assistant_catalog,
    methods=["GET"],
)
app.add_api_route(
    "/api/assistants/{assistant_id}/catalog-icon",
    chat_assets.assistant_icon,
    methods=["GET"],
)
OAUTH_HANDOFFS = handoff_store.OAuthHandoffStore()


class SessionEvidenceUnavailableError(RuntimeError):
    """The Local Supervisor authority could not provide current Supervisor evidence."""


@app.exception_handler(SessionEvidenceUnavailableError)
async def _session_evidence_unavailable(_request: Request, _exc: SessionEvidenceUnavailableError):
    return JSONResponse({"detail": "Supervisor authority is unavailable"}, status_code=503)


def _password_recovery_response() -> JSONResponse:
    return JSONResponse(
        {"code": "password-recovery-required", "detail": "Supervisor password recovery is required"},
        status_code=503,
    )


@app.exception_handler(audit.AuditUnavailableError)
async def _audit_unavailable(_request: Request, _exc: audit.AuditUnavailableError):
    log.error("Local Supervisor authentication audit is unavailable")
    return JSONResponse(
        {"detail": "Supervisor authentication audit is unavailable"},
        status_code=503,
        headers={"Cache-Control": "no-store"},
    )


@app.exception_handler(auth.PasswordRecordError)
async def _password_record_unavailable(_request: Request, _exc: auth.PasswordRecordError):
    return _password_recovery_response()


def _local_oauth_authorization_mode(request: Request) -> str:
    origin = chat_ws_common.canonical_origin(request.headers.get("origin"))
    if origin is None or origin not in _allowed_browser_origins():
        raise HTTPException(status_code=403, detail="OAuth authorization origin is not admitted")
    if origin == OAUTH_ORIGINS["loopback"]:
        return "loopback"
    if origin == OAUTH_ORIGINS["local-domain"]:
        return "local-domain"
    if origin.startswith("https://") and origin == state.browser_origin():
        return "out-of-band"
    raise HTTPException(status_code=409, detail="OAuth authorization is unavailable for this Admin address")


def _oauth_request_mode(request: Request) -> str | None:
    if request.url.scheme == "http" and request.url.hostname == "127.0.0.1" and request.url.port == 7777:
        return "loopback"
    if (
        request.url.hostname == "local.shimpz.com"
        and request.url.port is None
        and state.browser_origin() == OAUTH_ORIGINS["local-domain"]
    ):
        return "local-domain"
    return None


def _is_oauth_origin(request: Request) -> bool:
    return _oauth_request_mode(request) is not None


def _materialize_local_supervisor() -> None:
    supervisor.materialize_public_key(state.local_supervisor())


def _allowed_browser_origins() -> frozenset[str]:
    origins = set(chat_socket.STATIC_ORIGINS)
    if (browser_origin := state.browser_origin()) is not None:
        origins.add(browser_origin)
    return frozenset(origins)


def _session_evidence(cookies, *, activity: bool = False) -> dict[str, object] | None:
    if state.authentication_state() != auth.RECORD_STATE_CONFIGURED:
        return None
    record = state.get()
    session = auth.verify_session(
        record.get("session_secret", ""),
        cookies.get(COOKIE, ""),
        activity=activity,
    )
    try:
        evidence = supervisor.local_session_evidence(
            record,
            session_valid=session is not None,
        )
    except supervisor.SupervisorAuthorityError as exc:
        raise SessionEvidenceUnavailableError from exc
    if evidence is not None and session is not None:
        evidence["authentication_method"] = session.method
    return evidence


async def _session_active(cookies) -> bool:
    """A chat operation is Supervisor activity and restarts the session's idle time."""
    return _session_evidence(cookies, activity=True) is not None


async def _session_current(cookies) -> bool:
    """Admitting or watching a chat socket checks its session without counting as Supervisor activity."""
    return _session_evidence(cookies) is not None


def _supervisor_activity(request: Request) -> bool:
    """A request from Admin's own page is Supervisor activity, except the page's background refresh, which marks itself.

    Another page on the same site may still read with the session cookie, but its requests never renew the session.
    """
    return request.headers.get(BACKGROUND_HEADER) != "background" and browser.from_admin_page(
        request, _allowed_browser_origins
    )


def _team_session_scope(cookies, *, authority_kind: str = "session"):
    return team.supervisor_session(
        cookies.get(COOKIE, ""),
        local_identity=state.local_supervisor(),
        authority_kind=authority_kind,
    )


def _socket_origins() -> frozenset[str]:
    """The origins a page may open the chat socket to; unreadable state narrows them to the static ones."""
    try:
        return _allowed_browser_origins()
    except RuntimeError, OSError:
        return chat_socket.STATIC_ORIGINS


def _secure_response(response: Response) -> Response:
    """Apply the browser boundary consistently to SPA, API, and failure responses."""
    for name, value in browser.security_headers(SPA_SCRIPT_SOURCES, _socket_origins()).items():
        response.headers[name] = value
    return response


def _refused(response: Response) -> Response:
    """A Supervisor gate refusal is never cached, whichever API route it stands in for."""
    response.headers["Cache-Control"] = "no-store"
    return _secure_response(response)


def _supervisor_refusal(request: Request) -> Response | None:
    """Admit the current Supervisor's request from Admin's own page, or return the refusal that answers it."""
    try:
        evidence = _session_evidence(request.cookies)
    except SessionEvidenceUnavailableError:
        return JSONResponse({"detail": "Supervisor authority is unavailable"}, status_code=503)
    except auth.PasswordRecordError:
        return _password_recovery_response()
    if evidence is None:
        return JSONResponse({"detail": "unauthenticated"}, status_code=401)
    if not browser.admits_unsafe_request(request, _allowed_browser_origins):
        return JSONResponse({"detail": "browser origin is not admitted"}, status_code=403)
    # Only a request the gate admits counts as activity, so a refused cross-origin request never extends the session.
    if _supervisor_activity(request):
        auth.SESSIONS.current(request.cookies.get(COOKIE, ""), activity=True)
    request.state.supervisor = evidence
    return None


def _secured_send(send: Send, headers: dict[str, str]) -> Send:
    """Send the response with the browser boundary, and these headers, set on its start as it leaves."""

    async def secured(message: Message) -> None:
        if message["type"] == "http.response.start":
            response_headers = MutableHeaders(scope=message)
            for name, value in (headers | browser.security_headers(SPA_SCRIPT_SOURCES, _socket_origins())).items():
                response_headers[name] = value
        await send(message)

    return secured


async def _gate(scope: Scope, receive: Receive, send: Send, application: ASGIApp) -> None:
    """Keep static/auth routes open and validate the current Supervisor on every API call."""
    request = Request(scope, receive)
    path = request.url.path

    # Static SPA + assets (login form has no secret) and the open auth endpoints.
    if not path.startswith("/api/") or path in OPEN_API:
        headers = {}
        if path in {"/api/session", "/api/space/host"}:
            headers["Cache-Control"] = "no-store"
        if path == "/api/session":
            headers["Vary"] = "Origin"
        await application(scope, receive, _secured_send(send, headers))
        return
    # Everything else under /api/ requires a valid session and, to change state, Admin's own page.
    if (refusal := _supervisor_refusal(request)) is not None:
        await _refused(refusal)(scope, receive, send)
        return
    started = False

    async def sending(message: Message) -> None:
        nonlocal started
        started = True
        await send(message)

    try:
        with _team_session_scope(request.cookies):
            await application(scope, receive, _secured_send(sending, {}))
    except supervisor.SupervisorAuthorityError, team.TeamRequestError:
        # A response already under way cannot be replaced; it fails as the server error it is.
        if started:
            raise
        response = JSONResponse({"detail": "Supervisor authority is unavailable"}, status_code=503)
        await _refused(response)(scope, receive, send)


class _SupervisorGate:
    """Admin's HTTP gate as plain ASGI middleware.

    It adds no task or body stream per request, and the Team session scope's context reaches the route itself.
    WebSockets authenticate in the chat socket, and lifespan passes through.
    """

    def __init__(self, application: ASGIApp) -> None:
        self.application = application

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.application(scope, receive, send)
            return
        await _gate(scope, receive, send, self.application)


app.add_middleware(_SupervisorGate)


@app.post("/api/session")
async def session(request: Request):
    authentication_state = state.classified_authentication_state()
    if authentication_state == auth.RECORD_STATE_RECOVERY_REQUIRED:
        return {
            "profile": "local",
            "authenticated": False,
            "initialized": True,
            "authentication_state": authentication_state,
            "features": {"teamCredentials": TEAM_CREDENTIALS_ENABLED},
        }
    evidence = _session_evidence(request.cookies)
    response = {
        "profile": "local",
        "authenticated": evidence is not None,
        "features": {"teamCredentials": TEAM_CREDENTIALS_ENABLED},
        "initialized": authentication_state != auth.RECORD_STATE_UNINITIALIZED,
        "authentication_state": authentication_state,
    }
    if evidence is not None:
        origin = chat_ws_common.canonical_origin(request.headers.get("origin"))
        origin_admitted = origin is not None and origin in _allowed_browser_origins()
        response["origin_admitted"] = origin_admitted
        response["authentication_method"] = evidence["authentication_method"]
        response["passkey_enrollment_available"] = local_auth.passkey_enrollment_available(origin)
        response["passkey_registered"] = local_auth.passkey_registered(origin)
        if origin_admitted:
            completion_mode = browser.oauth_completion_mode(request, _local_oauth_authorization_mode)
            response["oauth_completion_mode"] = completion_mode
    return response


@app.post("/api/login")
async def login(request: Request):
    return await local_auth.login(request, _LOCAL_AUTH_CONTEXT)


@app.post("/api/logout")
async def logout(request: Request):
    session_token = request.cookies.get(COOKIE, "")
    raw_origin = request.headers.get("origin")
    origin = chat_ws_common.canonical_origin(raw_origin)
    if raw_origin is not None and (origin != raw_origin or origin not in _allowed_browser_origins()):
        raise HTTPException(status_code=403, detail="logout origin is not admitted")
    if session_token:
        if auth.verify_session(state.get().get("session_secret", ""), session_token) is not None:
            audit.record("logout", outcome="ok", origin=origin)
        try:
            await asyncio.to_thread(state.revoke_sessions_for_logout, session_token)
        except OSError:
            log.exception("Local Supervisor session revocation is unavailable")
            return JSONResponse(
                {"ok": False, "detail": "Local session revocation is unavailable"},
                status_code=503,
            )
        with suppress(handoff_store.OAuthHandoffError):
            OAUTH_HANDOFFS.cancel_session(session_token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


async def admin_setup(request: Request):
    async with _ADMIN_SETUP_LOCK:
        return await local_auth.setup(request, _LOCAL_AUTH_CONTEXT)


async def admin_setup_totp(request: Request):
    async with _ADMIN_SETUP_LOCK:
        return await local_auth.confirm_setup(request, _LOCAL_AUTH_CONTEXT)


async def local_login_totp(request: Request):
    return await local_auth.confirm_login_totp(request, _LOCAL_AUTH_CONTEXT)


async def local_login_passkey(request: Request):
    return await local_auth.confirm_login_passkey(request, _LOCAL_AUTH_CONTEXT)


async def local_login_recovery(request: Request):
    async with _ADMIN_SETUP_LOCK:
        return await local_auth.confirm_login_recovery(request, _LOCAL_AUTH_CONTEXT)


async def local_recovery_enrollment(request: Request):
    async with _ADMIN_SETUP_LOCK:
        return await local_auth.confirm_recovery_enrollment(request, _LOCAL_AUTH_CONTEXT)


async def recovery_codes_confirmation(request: Request):
    """Replacing the recovery codes starts with the Supervisor password, as any confirmed operation does (ADR-0051)."""

    async def begin() -> JSONResponse:
        try:
            return await local_auth.begin_operation(request, _LOCAL_AUTH_CONTEXT, local_auth.RECOVERY_CODES_SUBJECT)
        except local_auth.OperationRefusedError as exc:
            return local_auth.operation_refusal(exc)

    return await team_http.no_store(begin)


async def recovery_codes_replace(request: Request):
    async def replace() -> JSONResponse:
        payload = await team_http.bounded_json_object(request, local_auth.MAX_BODY_BYTES)
        try:
            response = await run_in_threadpool(
                local_auth.regenerate_recovery_codes, request, _LOCAL_AUTH_CONTEXT, payload
            )
        except local_auth.OperationRefusedError as exc:
            response = local_auth.operation_refusal(exc)
        # The ticket is spent either way; a stale cookie would only be refused.
        response.delete_cookie(local_auth.TICKET_COOKIE, path="/api/")
        return response

    return await team_http.no_store(replace)


async def supervisor_key_confirmation(request: Request):
    """Rotating the Supervisor key starts with the Supervisor password, as any confirmed operation does (ADR-0051)."""

    async def begin() -> JSONResponse:
        try:
            return await local_auth.begin_operation(request, _LOCAL_AUTH_CONTEXT, local_auth.SUPERVISOR_KEY_SUBJECT)
        except local_auth.OperationRefusedError as exc:
            return local_auth.operation_refusal(exc)

    return await team_http.no_store(begin)


async def supervisor_key_rotate(request: Request):
    async def rotate() -> JSONResponse:
        payload = await team_http.bounded_json_object(request, local_auth.MAX_BODY_BYTES)
        retry = getattr(app.state, "supervisor_key_recovery", None)
        try:
            response = await run_in_threadpool(
                local_auth.rotate_supervisor_key, request, _LOCAL_AUTH_CONTEXT, payload, retry
            )
        except local_auth.OperationRefusedError as exc:
            response = local_auth.operation_refusal(exc)
        # The ticket is spent either way; a stale cookie would only be refused.
        response.delete_cookie(local_auth.TICKET_COOKIE, path="/api/")
        return response

    return await team_http.no_store(rotate)


async def local_passkey_registration_begin(request: Request):
    return await local_auth.begin_passkey_registration(request, _LOCAL_AUTH_CONTEXT)


async def local_passkey_registration_complete(request: Request):
    return await local_auth.complete_passkey_registration(request, _LOCAL_AUTH_CONTEXT)


app.add_api_route("/api/admin/setup", admin_setup, methods=["POST"])
app.add_api_route("/api/admin/setup/totp", admin_setup_totp, methods=["POST"])
app.add_api_route("/api/login/totp", local_login_totp, methods=["POST"])
app.add_api_route("/api/login/passkey", local_login_passkey, methods=["POST"])
app.add_api_route("/api/login/recovery", local_login_recovery, methods=["POST"])
app.add_api_route("/api/login/recovery/totp", local_recovery_enrollment, methods=["POST"])
app.add_api_route("/api/admin/recovery-codes/confirmation", recovery_codes_confirmation, methods=["POST"])
app.add_api_route("/api/admin/recovery-codes", recovery_codes_replace, methods=["POST"])
app.add_api_route("/api/admin/supervisor-key/confirmation", supervisor_key_confirmation, methods=["POST"])
app.add_api_route("/api/admin/supervisor-key", supervisor_key_rotate, methods=["POST"])
app.add_api_route("/api/admin/passkeys/registration", local_passkey_registration_begin, methods=["POST"])
app.add_api_route("/api/admin/passkeys", local_passkey_registration_complete, methods=["POST"])


async def _host_reset_password(password: object) -> None:
    await local_auth._verify_password(password, _LOCAL_AUTH_CONTEXT)


def _team_delete_with_history(team_id: str, action) -> team.TeamResponse:
    with team_order.LOCK:
        return team_order.team_deleted(team_id, chat_history_http.team_delete(team_id, action))


def _space_reset_with_history(action) -> team.TeamResponse:
    # Admin owns the saved Team order, so a Space reset clears it with the history.
    with team_order.LOCK:
        return team_order.space_reset(chat_history_http.space_reset(action))


def _space_reset_response(action) -> JSONResponse:
    return _team_response(lambda: _space_reset_with_history(action))


def _established_host_reset(capability_digest: str) -> JSONResponse:
    binding = f"host-reset-v1:{capability_digest}"
    with _team_session_scope({COOKIE: binding}, authority_kind="host-reset"):
        return _space_reset_response(team.reset_space)


async def local_space_host_reset(request: Request):
    return await host_reset.reset(
        request,
        setup_lock=_ADMIN_SETUP_LOCK,
        read_json=partial(_bounded_json_object, max_bytes=MAX_TEAM_DELETE_BODY_BYTES),
        verify_password=_host_reset_password,
        bootstrap_reset=lambda: _space_reset_response(team.bootstrap_reset_space),
        established_reset=_established_host_reset,
    )


app.add_api_route("/api/space/host", local_space_host_reset, methods=["DELETE"])


async def local_space_reset(request: Request):
    return await space_reset.authenticated(
        request,
        max_password_chars=MAX_PASSWORD_CHARS,
        read_json=partial(_bounded_json_object, max_bytes=MAX_TEAM_DELETE_BODY_BYTES),
        recheck_password=partial(local_auth.recheck_password, context=_LOCAL_AUTH_CONTEXT),
        team_response=_space_reset_response,
    )


app.add_api_route("/api/space", local_space_reset, methods=["DELETE"])


# Teams and Assistants stay outside OPEN_API. Admin keeps Supervisor authentication while this
# adapter preserves Team's bounded status and JSON contract without gaining Docker access.
_team_response = team_http.response
_bounded_json_object = team_http.bounded_json_object


def model_providers_status():
    """Return masked local provider state; cleartext keys never leave the Admin backend."""
    return models.status()


async def model_provider_configure(provider: str, request: Request):
    payload = await _bounded_json_object(request)
    if set(payload) != {"api_key"}:
        raise HTTPException(status_code=400, detail="request body must contain only api_key")
    try:
        return await asyncio.to_thread(models.configure, provider, payload["api_key"])
    except models.ModelProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except models.ModelProviderUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def model_provider_delete(provider: str):
    try:
        return models.remove(provider)
    except models.ModelProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


app.add_api_route("/api/model-providers", model_providers_status, methods=["GET"])
app.add_api_route("/api/model-providers/{provider}", model_provider_configure, methods=["PUT"])
app.add_api_route("/api/model-providers/{provider}", model_provider_delete, methods=["DELETE"])
decision.register(app)


@app.get("/api/teams")
def teams_list():
    return team_order.listing()


team_names.register(app)
team_order.register(app)


@app.delete("/api/teams/{team_id}")
async def teams_destroy(team_id: str, request: Request):
    payload = await _bounded_json_object(request, MAX_TEAM_DELETE_BODY_BYTES)
    if set(payload) != {"team_name", "password"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name and password")
    team_name = payload["team_name"]
    password = payload["password"]
    if not isinstance(team_name, str) or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="Team name and password must be strings")
    if not 1 <= len(password) <= MAX_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")

    await local_auth.recheck_password(request, password, _LOCAL_AUTH_CONTEXT)
    return await run_in_threadpool(
        _team_response,
        lambda: _team_delete_with_history(team_id, lambda: team.destroy_confirmed(team_id, team_name)),
    )


@app.websocket("/api/teams/{team_id}/chat/ws")
async def team_chat_ws(websocket: WebSocket, team_id: str):
    await chat_socket.serve(
        websocket,
        team_id,
        session_ok=_session_active,
        session_current=_session_current,
        request_scope=_team_session_scope,
        allowed_origins=_allowed_browser_origins,
        authenticate=_AUTHENTICATE_ACTION_REQUEST,
    )


def team_chat_history(team_id: str, before: str | None = None, routine: str | None = None):
    return chat_history_http.page(team_id, before, routine)


app.add_api_route("/api/teams/{team_id}/chat/history", team_chat_history, methods=["GET"])


@app.get("/api/teams/{team_id}/assistant-integrations")
def team_assistant_integrations(team_id: str):
    response = _team_response(lambda: integrations.list_assistant_integrations(team_id))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/teams/{team_id}/assistant-stored-inputs")
def team_assistant_stored_inputs(team_id: str):
    response = _team_response(lambda: action_stored_input.list_assistant_stored_inputs(team_id))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.delete("/api/teams/{team_id}/assistant-stored-inputs/{assistant_id}/{stored_input_id}")
async def team_assistant_stored_input_clear(
    team_id: str,
    assistant_id: str,
    stored_input_id: str,
):
    with team_http.refused_as_bad_request():
        response = await asyncio.to_thread(
            action_stored_input.clear_assistant_stored_input,
            team_id,
            assistant_id,
            stored_input_id,
        )
    return JSONResponse(response.body, status_code=response.status, headers={"Cache-Control": "no-store"})


async def team_assistant_integration_authorize(team_id: str, challenge_id: str, request: Request):
    payload = await _bounded_json_object(request)
    if set(payload) != {"assistant_id", "integration_id"}:
        raise HTTPException(
            status_code=400,
            detail="request body must contain only assistant_id and integration_id",
        )
    session_token = request.cookies.get(COOKIE, "")
    preparation = None
    authorized = False
    try:
        callback_mode = _local_oauth_authorization_mode(request)
        canonical_team = team.canonical_team_id(team_id)
        canonical_challenge = team.canonical_challenge_id(challenge_id)
        preparation = OAUTH_HANDOFFS.issue(
            team_id=canonical_team,
            challenge_id=canonical_challenge,
            admin_session=session_token,
            callback_mode=callback_mode,
        )
        result = await asyncio.to_thread(
            integrations.start_local_assistant_integration_authorization,
            canonical_team,
            canonical_challenge,
            payload["assistant_id"],
            payload["integration_id"],
            preparation.session_binding,
            callback_mode,
        )
        if result.status != 200:
            return JSONResponse(
                result.body,
                status_code=result.status,
                headers={"Cache-Control": "no-store"},
            )
        OAUTH_HANDOFFS.authorize(preparation.token, result.body.get("authorization_url"))
        authorized = True
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except handoff_store.OAuthHandoffError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    finally:
        if preparation is not None and not authorized:
            OAUTH_HANDOFFS.discard(preparation.token)
    if callback_mode == "out-of-band":
        authorization_url = result.body["authorization_url"]
        completion_mode = "code"
    else:
        authorization_url = (
            OAUTH_ORIGINS[callback_mode] + OAUTH_START_PATH + "?" + urlencode({"handoff": preparation.token})
        )
        completion_mode = "automatic"
    return JSONResponse(
        {"authorization_url": authorization_url, "completion_mode": completion_mode},
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


async def team_assistant_integration_complete(team_id: str, challenge_id: str, request: Request):
    payload = await _bounded_json_object(request)
    if set(payload) != {"completion_code"}:
        raise HTTPException(status_code=400, detail="request body must contain only completion_code")
    try:
        completion = OAUTH_HANDOFFS.complete(
            team_id=team.canonical_team_id(team_id),
            challenge_id=team.canonical_challenge_id(challenge_id),
            admin_session=request.cookies.get(COOKIE, ""),
            completion_code=payload["completion_code"],
        )
        result = await asyncio.to_thread(
            integrations.complete_cloudflare_oauth_callback,
            state=completion.state,
            claim=completion.claim,
            session_binding=completion.session_binding,
        )
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except handoff_store.OAuthHandoffError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return JSONResponse(result.body, status_code=result.status, headers={"Cache-Control": "no-store"})


async def team_assistant_integration_cancel(team_id: str, challenge_id: str, request: Request):
    payload = await _bounded_json_object(request)
    if payload:
        raise HTTPException(status_code=400, detail="request body must be an empty JSON object")
    try:
        canonical_team = team.canonical_team_id(team_id)
        canonical_challenge = team.canonical_challenge_id(challenge_id)
        binding = OAUTH_HANDOFFS.cancel(
            team_id=canonical_team,
            challenge_id=canonical_challenge,
            admin_session=request.cookies.get(COOKIE, ""),
        )
        if binding is None:
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        result = await asyncio.to_thread(
            integrations.cancel_local_assistant_integration_authorization,
            canonical_team,
            canonical_challenge,
            binding,
        )
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except handoff_store.OAuthHandoffError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    if result.status == 204:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return JSONResponse(result.body, status_code=result.status, headers={"Cache-Control": "no-store"})


app.add_api_route(
    "/api/teams/{team_id}/assistant-integrations/challenges/{challenge_id}/authorize",
    team_assistant_integration_authorize,
    methods=["POST"],
)
app.add_api_route(
    "/api/teams/{team_id}/assistant-integrations/challenges/{challenge_id}/complete",
    team_assistant_integration_complete,
    methods=["POST"],
)
app.add_api_route(
    "/api/teams/{team_id}/assistant-integrations/challenges/{challenge_id}/authorize",
    team_assistant_integration_cancel,
    methods=["DELETE"],
)


@app.delete("/api/teams/{team_id}/assistant-integrations/{assistant_id}/{integration_id}")
async def team_assistant_integration_disconnect(team_id: str, assistant_id: str, integration_id: str):
    with team_http.refused_as_bad_request():
        response = await asyncio.to_thread(
            integrations.disconnect_assistant_integration,
            team_id,
            assistant_id,
            integration_id,
        )
    if response.status == 204 and not response.body:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return JSONResponse(response.body, status_code=response.status, headers={"Cache-Control": "no-store"})


@app.get("/api/oauth/cloudflare/start")
async def oauth_cloudflare_start(request: Request, handoff: str = ""):
    request_mode = _oauth_request_mode(request)
    if request_mode is None:
        with suppress(handoff_store.OAuthHandoffError):
            OAUTH_HANDOFFS.discard(handoff)
        return _OAUTH_CHAT_REDIRECT("start-failed")
    try:
        pending = OAUTH_HANDOFFS.consume(handoff, request_mode)
    except handoff_store.OAuthHandoffError:
        return _OAUTH_CHAT_REDIRECT("start-failed")
    response = RedirectResponse(pending.authorization_url, status_code=303)
    domain_callback = pending.callback_mode == "local-domain"
    response.set_cookie(
        OAUTH_COOKIE,
        pending.session_binding,
        max_age=OAUTH_COOKIE_TTL,
        httponly=True,
        samesite="none" if domain_callback else "lax",
        secure=domain_callback,
        path=OAUTH_COOKIE_PATH,
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/oauth/cloudflare/callback")
async def oauth_cloudflare_callback(request: Request):
    if not _is_oauth_origin(request):
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    pairs = list(request.query_params.multi_items())
    if len(pairs) != 2 or {key for key, _value in pairs} != {"state", "claim"}:
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    query = dict(pairs)
    binding = request.cookies.get(OAUTH_COOKIE, "")
    try:
        result = await asyncio.to_thread(
            integrations.complete_cloudflare_oauth_callback,
            state=query["state"],
            claim=query["claim"],
            session_binding=binding,
        )
    except team.TeamRequestError:
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    if result.status != 200:
        log.info("OAuth callback rejected (HTTP %s)", result.status)
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    return _OAUTH_CHAT_REDIRECT()


@app.get("/api/teams/{team_id}/assistants")
def team_assistants_list(team_id: str):
    return _team_response(lambda: team.list_installed_assistants(team_id))


@app.post("/api/teams/{team_id}/assistants")
async def team_assistant_install(team_id: str, request: Request):
    payload = await _bounded_json_object(request)
    return await run_in_threadpool(
        _team_response,
        lambda: team.install_assistant(team_id, payload),
    )


async def team_local_assistant_install(team_id: str, request: Request):
    payload = await _bounded_json_object(request)
    return await run_in_threadpool(
        _team_response,
        lambda: team.install_local_assistant(team_id, payload),
    )


team_snapshots.register(app)
app.add_api_route(
    "/api/teams/{team_id}/assistants/local",
    team_local_assistant_install,
    methods=["POST"],
)


@app.delete("/api/teams/{team_id}/assistants/{assistant_id}")
def team_assistant_uninstall(team_id: str, assistant_id: str):
    return _team_response(lambda: team.uninstall_assistant(team_id, assistant_id))


team_files.register(app)


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def unknown_api(path: str):
    """Keep unknown API paths out of the SPA fallback and fail honestly."""
    raise HTTPException(status_code=404, detail=f"unknown API endpoint: /api/{path}")


if UI_DIR.is_dir():
    # SPA serve: return a real asset if the path maps to one, else fall back to index.html so a
    # client-routed view (e.g. /teams) works on a direct load / refresh — not just via in-app nav
    # (StaticFiles(html=True) 404s nested routes). The explicit /api/* fallback above prevents API
    # typos or retired endpoints from being answered with the SPA shell.
    @app.get("/{path:path}")
    def spa(path: str):
        # Only a relative path can name an asset, and its real path, symlinks resolved, must stay inside the UI root.
        ui_root = os.path.realpath(UI_DIR)
        if not Path(path).is_absolute():
            candidate = os.path.realpath(Path(ui_root, path))
            if candidate.startswith(ui_root + os.sep) and Path(candidate).is_file():
                return FileResponse(candidate)
        return FileResponse(Path(ui_root, "index.html"))
else:

    @app.get("/")
    async def no_ui():
        # Loud, not silent: APIs stay usable (tests/CI), humans are told exactly what to run.
        return PlainTextResponse("UI not built — build admin/frontend (npm run build).")
