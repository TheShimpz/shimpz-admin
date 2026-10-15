"""The Local Admin API and static UI server running in the `shimpz-admin` container.

The Supervisor authenticates with its one separately set password and session. Query parameters
never grant a session.

The static SPA + the auth endpoints are open (the login form carries no secret); every Team,
Assistant, model-provider, OAuth, and chat endpoint requires a valid session. This
process holds no Docker socket and has no host configuration write surface.
"""

import asyncio
import logging
import mimetypes
import os
import sys
from contextlib import asynccontextmanager, suppress
from functools import partial
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

sys.path.insert(0, str(Path(__file__).resolve().parent))
import browser
import state
import supervisor
from history import http as chat_history_http
from session import socket as session_socket
from session import topics as session_topics
from signin import audit, auth, local_auth
from space import host_reset, supervisor_key
from space import reset as space_reset
from team import assets as team_assets
from team import bridge as team
from team import files as team_files
from team import http as team_http
from team import order as team_order
from team import transport

from chat import assets as chat_assets
from chat import human as chat_human
from integrations import assistants as integrations
from integrations import authorization
from integrations import handoff as handoff_store
from protocol.http.v1 import websocket as chat_ws_common
from routine import scheduler as routine_scheduler

log = logging.getLogger("shimpz-admin")
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
OAUTH_COOKIE_PATH = "/api/oauth/cloudflare"
OAUTH_COOKIE_TTL = 300
_OAUTH_CHAT_REDIRECT = partial(
    browser.oauth_chat_redirect,
    cookie_name=OAUTH_COOKIE,
    cookie_path=OAUTH_COOKIE_PATH,
)
_ADMIN_SETUP_LOCK = asyncio.Lock()
MAX_SPACE_RESET_BODY_BYTES = 8 * 1024
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
team_assets.register(app)
app.add_api_route(
    "/api/assistants/{assistant_id}/catalog-icon",
    chat_assets.assistant_icon,
    methods=["GET"],
)


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


def _oauth_request_mode(request: Request) -> str | None:
    if request.url.scheme == "http" and request.url.hostname == "127.0.0.1" and request.url.port == 7777:
        return "loopback"
    if (
        request.url.hostname == "local.shimpz.com"
        and request.url.port is None
        and state.browser_origin() == authorization.OAUTH_ORIGINS["local-domain"]
    ):
        return "local-domain"
    return None


def _is_oauth_origin(request: Request) -> bool:
    return _oauth_request_mode(request) is not None


def _materialize_local_supervisor() -> None:
    supervisor.materialize_public_key(state.local_supervisor())


def _allowed_browser_origins() -> frozenset[str]:
    origins = set(browser.STATIC_ORIGINS)
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


async def _renew_session(cookies) -> bool:
    """The Supervisor's own input, reported by the session socket's activity frame, restarts the idle time.

    It renews only a session that is still current: never one that idled out or reached its absolute expiry.
    """
    return _session_evidence(cookies, activity=True) is not None


async def _session_current(cookies) -> bool:
    """Every request, socket frame, and watcher check the session without renewing it."""
    return _session_evidence(cookies) is not None


def _session_deadlines(cookies) -> tuple[float, float] | None:
    """Seconds until the socket's session idles out and until its absolute expiry; its timer closes it then."""
    return auth.session_deadlines(state.get().get("session_secret", ""), cookies.get(COOKIE, ""))


def _team_session_scope(cookies, *, authority_kind: str = "session"):
    return transport.supervisor_session(
        cookies.get(COOKIE, ""),
        local_identity=state.local_supervisor(),
        authority_kind=authority_kind,
    )


def _socket_origins() -> frozenset[str]:
    """The origins a page may open the session socket to; unreadable state narrows them to the static ones."""
    try:
        return _allowed_browser_origins()
    except RuntimeError, OSError:
        return browser.STATIC_ORIGINS


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
    request.state.supervisor = evidence
    return None


def _secured_send(send: Send, headers: dict[str, str]) -> Send:
    """Send the response with the browser boundary, and these headers, set on its start as it leaves."""

    async def secured(message: Message) -> None:
        if message["type"] == "http.response.start":
            response_headers = MutableHeaders(scope=message)
            for name, value in (headers | browser.security_headers(SPA_SCRIPT_SOURCES, _socket_origins())).items():
                # A route's own policy stands: only a response that is never a page sets one, stricter than the page's.
                if name == "Content-Security-Policy" and name in response_headers:
                    continue
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
    except supervisor.SupervisorAuthorityError, transport.TeamRequestError:
        # A response already under way cannot be replaced; it fails as the server error it is.
        if started:
            raise
        response = JSONResponse({"detail": "Supervisor authority is unavailable"}, status_code=503)
        await _refused(response)(scope, receive, send)


class _SupervisorGate:
    """Admin's HTTP gate as plain ASGI middleware.

    It adds no task or body stream per request, and the Team session scope's context reaches the route itself.
    WebSockets authenticate in the session socket, and lifespan passes through.
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
            completion_mode = browser.oauth_completion_mode(
                lambda: authorization.callback_mode(origin, _allowed_browser_origins)
            )
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
            authorization.HANDOFFS.cancel_session(session_token)
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
app.add_api_route("/api/admin/passkeys/registration", local_passkey_registration_begin, methods=["POST"])
app.add_api_route("/api/admin/passkeys", local_passkey_registration_complete, methods=["POST"])


async def _host_reset_password(password: object) -> None:
    await local_auth.check_password(password, _LOCAL_AUTH_CONTEXT)


def _space_reset_with_history(action) -> transport.TeamResponse:
    # Admin owns the saved Team order, so a Space reset clears it with the history.
    with team_order.LOCK:
        response = team_order.space_reset(chat_history_http.space_reset(action))
    session_topics.changed("teams")
    return response


def _space_reset_response(action) -> JSONResponse:
    return team_http.response(lambda: _space_reset_with_history(action))


def _established_host_reset(capability_digest: str) -> JSONResponse:
    binding = f"host-reset-v1:{capability_digest}"
    with _team_session_scope({COOKIE: binding}, authority_kind="host-reset"):
        return _space_reset_response(team.reset_space)


async def local_space_host_reset(request: Request):
    return await host_reset.reset(
        request,
        setup_lock=_ADMIN_SETUP_LOCK,
        read_json=partial(team_http.bounded_json_object, max_bytes=MAX_SPACE_RESET_BODY_BYTES),
        verify_password=_host_reset_password,
        bootstrap_reset=lambda: _space_reset_response(team.bootstrap_reset_space),
        established_reset=_established_host_reset,
    )


app.add_api_route("/api/space/host", local_space_host_reset, methods=["DELETE"])


async def local_space_reset(request: Request):
    return await space_reset.authenticated(
        request,
        max_password_chars=MAX_PASSWORD_CHARS,
        read_json=partial(team_http.bounded_json_object, max_bytes=MAX_SPACE_RESET_BODY_BYTES),
        recheck_password=partial(local_auth.recheck_password, context=_LOCAL_AUTH_CONTEXT),
        team_response=_space_reset_response,
    )


app.add_api_route("/api/space", local_space_reset, methods=["DELETE"])


def _session_gate() -> session_socket.Gate:
    """What Admin's HTTP gate decides, handed to one session socket as it opens."""
    return session_socket.Gate(
        session_current=_session_current,
        renew_session=_renew_session,
        allowed_origins=_allowed_browser_origins,
        request_scope=_team_session_scope,
        session_deadlines=_session_deadlines,
        authenticate=_AUTHENTICATE_ACTION_REQUEST,
        recheck_password=partial(local_auth.recheck_password, context=_LOCAL_AUTH_CONTEXT),
        confirmations=_LOCAL_AUTH_CONTEXT,
        cookie=COOKIE,
    )


@app.websocket(session_socket.frames.PATH)
async def session_ws(websocket: WebSocket):
    await session_socket.serve(websocket, _session_gate())


@app.get("/api/oauth/cloudflare/start")
async def oauth_cloudflare_start(request: Request, handoff: str = ""):
    request_mode = _oauth_request_mode(request)
    if request_mode is None:
        with suppress(handoff_store.OAuthHandoffError):
            authorization.HANDOFFS.discard(handoff)
        return _OAUTH_CHAT_REDIRECT("start-failed")
    try:
        pending = authorization.HANDOFFS.consume(handoff, request_mode)
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
    except transport.TeamRequestError:
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    if result.status != 200:
        log.info("OAuth callback rejected (HTTP %s)", result.status)
        return _OAUTH_CHAT_REDIRECT("callback-failed")
    return _OAUTH_CHAT_REDIRECT()


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
    # client-routed view (e.g. /assistants) works on a direct load / refresh — not just via in-app nav
    # (StaticFiles(html=True) 404s nested routes). The explicit /api/* fallback above prevents API
    # typos or retired endpoints from being answered with the SPA shell.
    @app.get("/{path:path}")
    def spa(path: str, request: Request):
        # Only a relative path can name an asset, and its real path, symlinks resolved, must stay inside the UI root. A
        # precompressed sibling is never an asset of its own: it answers only for its file, in that file's type.
        ui_root = os.path.realpath(UI_DIR)
        asset = Path(ui_root, "index.html")
        if not Path(path).is_absolute() and not path.endswith(browser.ENCODED_SUFFIXES):
            candidate = os.path.realpath(Path(ui_root, path))
            if candidate.startswith(ui_root + os.sep) and Path(candidate).is_file():
                asset = Path(candidate)
        sent, coding = browser.static_representation(asset, ui_root, request.headers.get("accept-encoding", ""))
        response = FileResponse(sent, media_type=mimetypes.guess_type(asset)[0] or "text/plain")
        if coding is not None:
            response.headers["Content-Encoding"] = coding
        response.headers.add_vary_header("Accept-Encoding")
        # A content-hashed build file never changes; everything else, the shell first, is checked on every load, so a
        # reload after an update always reaches the new build.
        immutable = asset.is_relative_to(Path(ui_root, "_app", "immutable"))
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response
else:

    @app.get("/")
    async def no_ui():
        # Loud, not silent: APIs stay usable (tests/CI), humans are told exactly what to run.
        return PlainTextResponse("UI not built — build admin/frontend (npm run build).")
