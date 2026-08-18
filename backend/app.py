"""The profile-aware Admin API and static UI server running in the `shimpz-admin` container.

Local uses its one separately authenticated Supervisor password and session. Hosted accepts only an
online, enabled Account session with current Supervisor privilege. Query parameters never grant a
session in either profile.

The static SPA + the auth endpoints are open (the login form carries no secret); every Team,
Assistant, model-provider, OAuth, notification, and chat endpoint requires a valid session. This
process holds no Docker socket and has no host configuration write surface.
"""

import asyncio
import json
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
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

sys.path.insert(0, str(Path(__file__).resolve().parent))
import profile

import auth
import models
import notifications
import platform_release
import state
import supervisor
from team import assets as team_assets
from team import bridge as team

import browser
from chat import human as chat_human
from chat import socket as chat_socket
from integrations import account as account_identity
from integrations import assistants as integrations
from integrations import handoff as handoff_store
from protocol.http.v1 import websocket as chat_ws_common

log = logging.getLogger("shimpz-admin")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


ADMIN_PROFILE = profile.require()
_AUTHENTICATE_ACTION_REQUEST = chat_human.LocalPasswordAuthority(
    partial(
        chat_human.authenticate_local,
        profile=ADMIN_PROFILE,
        record_get=state.get,
    )
)
TEAM_CREDENTIALS_ENABLED = (
    ADMIN_PROFILE == "local" and os.environ.get("SHIMPZ_TEAM_CREDENTIALS_ENABLED", "1").strip() == "1"
)

UI_DIR = Path(__file__).resolve().parent.parent / "frontend" / "build"
COOKIE = "shimpz_admin"
OAUTH_COOKIE = "shimpz_oauth_binding"
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
    "hosted": "https://local.shimpz.com",
}
MIN_PASSWORD_LEN = 12
MAX_TEAM_DELETE_BODY_BYTES = 8 * 1024
MAX_PASSWORD_CHARS = 4 * 1024
MAX_ACCOUNT_USERNAME_CHARS = 32
ACCOUNT_COOKIE_TTL = 14 * 24 * 60 * 60
BROWSER_SECURITY_HEADERS = browser.security_headers(UI_DIR)

# Open surface: the SPA shell (served for any non-/api path) + these auth endpoints. Everything
# else under /api/ needs a session.
OPEN_API = frozenset(
    {
        "/api/session",
        "/api/login",
        "/api/logout",
    }
    | (
        {
            "/api/admin/setup",
            "/api/oauth/cloudflare/start",
            "/api/oauth/cloudflare/callback",
        }
        if ADMIN_PROFILE == "local"
        else set()
    )
)


@asynccontextmanager
async def _lifespan(_application: FastAPI):
    if profile.require() != ADMIN_PROFILE:
        raise RuntimeError("Admin profile changed after route registration")
    if ADMIN_PROFILE == "local" and state.is_initialized():
        await asyncio.to_thread(_materialize_local_supervisor)
    yield


app = FastAPI(title="shimpz-admin", docs_url=None, redoc_url=None, openapi_url=None, lifespan=_lifespan)
platform_release.register(app, ADMIN_PROFILE)
app.add_api_route(
    "/api/teams/{team_id}/assistants/{assistant_id}/icon",
    team_assets.assistant_icon,
    methods=["GET"],
)
OAUTH_HANDOFFS = handoff_store.OAuthHandoffStore()


class SessionEvidenceUnavailableError(RuntimeError):
    """The profile authority could not provide current Supervisor evidence."""


@app.exception_handler(SessionEvidenceUnavailableError)
async def _session_evidence_unavailable(_request: Request, _exc: SessionEvidenceUnavailableError):
    return JSONResponse({"detail": "Account identity is unavailable"}, status_code=503)


def _local_oauth_authorization_mode(request: Request) -> str:
    origin = chat_ws_common.canonical_origin(request.headers.get("origin"))
    if origin is None or origin not in _allowed_browser_origins():
        raise HTTPException(status_code=403, detail="OAuth authorization origin is not admitted")
    if origin == OAUTH_ORIGINS["loopback"]:
        return "loopback"
    if origin == OAUTH_ORIGINS["hosted"]:
        return "hosted"
    if origin.startswith("https://") and origin == state.browser_origin():
        return "out-of-band"
    raise HTTPException(status_code=409, detail="OAuth authorization is unavailable for this Admin address")


def _oauth_request_mode(request: Request) -> str | None:
    if ADMIN_PROFILE != "local":
        return None
    if request.url.scheme == "http" and request.url.hostname == "127.0.0.1" and request.url.port == 7777:
        return "loopback"
    if (
        request.url.hostname == "local.shimpz.com"
        and request.url.port is None
        and state.browser_origin() == OAUTH_ORIGINS["hosted"]
    ):
        return "hosted"
    return None


def _is_oauth_origin(request: Request) -> bool:
    return _oauth_request_mode(request) is not None


def _set_session(resp, token, browser_origin: str | None = None):
    resp.set_cookie(
        COOKIE,
        token,
        max_age=auth.TTL if ADMIN_PROFILE == "local" else ACCOUNT_COOKIE_TTL,
        httponly=True,
        samesite="strict",
        secure=ADMIN_PROFILE == "hosted" or browser_origin is not None,
        path="/",
    )


def _materialize_local_supervisor() -> None:
    supervisor.materialize_public_key(state.local_supervisor())


def _initialize_local_supervisor(password: str, browser_origin: str | None = None) -> None:
    state.set_password(password, browser_origin)
    _materialize_local_supervisor()


def _allowed_browser_origins() -> frozenset[str]:
    origins = set(chat_socket.STATIC_ORIGINS)
    if ADMIN_PROFILE == "local" and (browser_origin := state.browser_origin()) is not None:
        origins.add(browser_origin)
    return frozenset(origins)


def _request_browser_origin(request: Request) -> str | None:
    raw_origin = request.headers.get("origin")
    if raw_origin is None:
        return None
    origin = chat_ws_common.canonical_origin(raw_origin)
    if origin is None or origin != raw_origin:
        raise HTTPException(status_code=403, detail="request Origin must be one exact HTTPS address")
    if origin in chat_socket.STATIC_ORIGINS:
        return None
    if not origin.startswith("https://"):
        raise HTTPException(status_code=403, detail="external Admin addresses must use HTTPS")
    return origin


async def _bind_browser_origin(origin: str | None) -> None:
    if origin is None:
        return
    transition = await asyncio.to_thread(state.bind_browser_origin, origin)
    if transition != "unchanged":
        log.info("Local Admin browser origin %s: %s", transition, origin)


def _local_session_evidence(cookies) -> dict[str, object] | None:
    record = state.get()
    try:
        return supervisor.local_session_evidence(
            record,
            session_valid=auth.verify_session(
                record.get("session_secret", ""),
                cookies.get(COOKIE, ""),
            ),
        )
    except supervisor.SupervisorAuthorityError as exc:
        raise SessionEvidenceUnavailableError from exc


async def _session_evidence(cookies) -> dict[str, object] | None:
    if ADMIN_PROFILE == "local":
        return _local_session_evidence(cookies)
    token = cookies.get(COOKIE, "")
    if not token:
        return None
    response = await account_identity.run_bounded(account_identity.introspect, token)
    if response.status == 401:
        return None
    if response.status != 200:
        raise SessionEvidenceUnavailableError
    if response.body.get("active") is not True or response.body.get("supervisor") is not True:
        return None
    return response.body


async def _session_ok(cookies) -> bool:
    return await _session_evidence(cookies) is not None


def _team_session_scope(cookies):
    token = cookies.get(COOKIE, "")
    if ADMIN_PROFILE == "hosted":
        return team.supervisor_session(token, account=True)
    return team.supervisor_session(
        token,
        account=False,
        local_identity=state.local_supervisor(),
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    return forwarded or (request.client.host if request.client else "")


def _secure_response(response: Response) -> Response:
    """Apply the browser boundary consistently to SPA, API, and failure responses."""
    for name, value in BROWSER_SECURITY_HEADERS.items():
        response.headers[name] = value
    return response


@app.middleware("http")
async def _gate(request: Request, call_next):
    """Keep static/auth routes open and validate the profile's current Supervisor on every API call."""
    path = request.url.path

    # Static SPA + assets (login form has no secret) and the open auth endpoints.
    if not path.startswith("/api/") or path in OPEN_API:
        response = await call_next(request)
        if path == "/api/session":
            response.headers["Cache-Control"] = "no-store"
            response.headers["Vary"] = "Origin"
        return _secure_response(response)
    # Everything else under /api/ requires a valid session.
    try:
        evidence = await _session_evidence(request.cookies)
    except SessionEvidenceUnavailableError:
        response = JSONResponse({"detail": "Account identity is unavailable"}, status_code=503)
        return _secure_response(response)
    if evidence is None:
        response = JSONResponse({"detail": "unauthenticated"}, status_code=401)
        return _secure_response(response)
    request.state.supervisor = evidence
    try:
        with _team_session_scope(request.cookies):
            response = await call_next(request)
            return _secure_response(response)
    except supervisor.SupervisorAuthorityError, team.TeamRequestError:
        response = JSONResponse({"detail": "Supervisor authority is unavailable"}, status_code=503)
        return _secure_response(response)


@app.post("/api/session")
async def session(request: Request):
    evidence = await _session_evidence(request.cookies)
    response = {
        "profile": ADMIN_PROFILE,
        "authenticated": evidence is not None,
        "features": {"teamCredentials": TEAM_CREDENTIALS_ENABLED},
    }
    if ADMIN_PROFILE == "local":
        response["initialized"] = state.is_initialized()
        if evidence is not None:
            origin = chat_ws_common.canonical_origin(request.headers.get("origin"))
            origin_admitted = origin is not None and origin in _allowed_browser_origins()
            response["origin_admitted"] = origin_admitted
            if origin_admitted:
                completion_mode = browser.oauth_completion_mode(request, _local_oauth_authorization_mode)
                response["oauth_completion_mode"] = completion_mode
    else:
        response["account_id"] = evidence.get("account_id") if evidence is not None else None
    return response


async def _local_login(request: Request, payload: dict) -> JSONResponse:
    if set(payload) != {"password"} or not isinstance(payload["password"], str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    if not state.is_initialized():
        raise HTTPException(status_code=409, detail="no admin password set yet — create one first")
    browser_origin = _request_browser_origin(request)
    rec = state.get()
    password_ok = await asyncio.to_thread(
        auth.verify_password,
        payload["password"],
        rec.get("salt", ""),
        rec.get("password_hash", ""),
    )
    if not password_ok:
        log.info("login failed")  # never the password
        raise HTTPException(status_code=401, detail="wrong password")
    await _bind_browser_origin(browser_origin)
    resp = JSONResponse({"ok": True})
    _set_session(resp, auth.issue_session(rec["session_secret"]), browser_origin)
    log.info("login ok")
    return resp


async def _hosted_login(request: Request, payload: dict) -> JSONResponse:
    if set(payload) != {"username", "password"}:
        raise HTTPException(status_code=400, detail="request body must contain only username and password")
    username = payload["username"]
    password = payload["password"]
    if (
        not isinstance(username, str)
        or not 1 <= len(username) <= MAX_ACCOUNT_USERNAME_CHARS
        or not isinstance(password, str)
        or not 1 <= len(password) <= MAX_PASSWORD_CHARS
    ):
        raise HTTPException(status_code=400, detail="invalid Account credentials")
    logged_in = await account_identity.run_bounded(
        account_identity.login,
        username,
        password,
        _client_ip(request),
    )
    if logged_in.status == 401:
        raise HTTPException(status_code=401, detail="invalid username or password")
    if logged_in.status != 200:
        raise HTTPException(status_code=503, detail="Account identity is unavailable")
    token = logged_in.body["token"]
    evidence = await account_identity.run_bounded(account_identity.introspect, token)
    if evidence.status != 200:
        await account_identity.run_bounded(account_identity.logout, token)
        raise HTTPException(status_code=503, detail="Account identity is unavailable")
    if evidence.body.get("active") is not True or evidence.body.get("supervisor") is not True:
        await account_identity.run_bounded(account_identity.logout, token)
        raise HTTPException(status_code=403, detail="Supervisor privilege is required")
    response = JSONResponse({"ok": True, "account_id": evidence.body["account_id"]})
    _set_session(response, token)
    log.info("Hosted Supervisor login ok")
    return response


@app.post("/api/login")
async def login(request: Request):
    payload = await _bounded_json_object(request, MAX_TEAM_DELETE_BODY_BYTES)
    if ADMIN_PROFILE == "local":
        return await _local_login(request, payload)
    return await _hosted_login(request, payload)


@app.post("/api/logout")
async def logout(request: Request):
    session_token = request.cookies.get(COOKIE, "")
    if session_token:
        with suppress(handoff_store.OAuthHandoffError):
            OAUTH_HANDOFFS.cancel_session(session_token)
    status = 200
    if ADMIN_PROFILE == "hosted" and session_token:
        revoked = await account_identity.run_bounded(account_identity.logout, session_token)
        if revoked.status != 200:
            status = 503
    body = {"ok": status == 200}
    if status != 200:
        body["detail"] = "Account session revocation is unavailable"
    resp = JSONResponse(body, status_code=status)
    resp.delete_cookie(COOKIE, path="/")
    return resp


async def admin_setup(request: Request):
    payload = await _bounded_json_object(request, MAX_TEAM_DELETE_BODY_BYTES)
    if set(payload) != {"password"} or not isinstance(payload["password"], str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    browser_origin = _request_browser_origin(request)
    async with _ADMIN_SETUP_LOCK:
        if state.is_initialized():
            raise HTTPException(status_code=409, detail="admin password already set")
        password = payload["password"]
        if len(password) < MIN_PASSWORD_LEN:
            raise HTTPException(status_code=400, detail=f"password must be at least {MIN_PASSWORD_LEN} characters")
        if len(password) > MAX_PASSWORD_CHARS:
            raise HTTPException(status_code=400, detail="password is too long")
        await asyncio.to_thread(_initialize_local_supervisor, password, browser_origin)
        if browser_origin is not None:
            log.info("Local Admin browser origin learned: %s", browser_origin)
    resp = JSONResponse({"ok": True})
    _set_session(resp, auth.issue_session(state.get()["session_secret"]), browser_origin)
    log.info("admin password created")
    return resp


if ADMIN_PROFILE == "local":
    app.add_api_route("/api/admin/setup", admin_setup, methods=["POST"])


async def local_space_reset(request: Request):
    payload = await _bounded_json_object(request, MAX_TEAM_DELETE_BODY_BYTES)
    if set(payload) != {"password"} or not isinstance(payload["password"], str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    password = payload["password"]
    if not 1 <= len(password) <= MAX_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")
    record = state.get()
    try:
        password_ok = await asyncio.to_thread(
            auth.verify_password,
            password,
            record.get("salt", ""),
            record.get("password_hash", ""),
        )
    except TypeError, ValueError:
        log.warning("Admin password record is invalid")
        raise HTTPException(status_code=503, detail="Supervisor password verification is unavailable") from None
    if not password_ok:
        log.info("Space reset password confirmation failed")
        raise HTTPException(status_code=403, detail="Supervisor password is incorrect")
    try:
        response = await run_in_threadpool(team.reset_space)
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    # Admin owns the bounded Supervisor success contract; Team owns operation failure semantics.
    if not 200 <= response.status < 300:
        return JSONResponse(status_code=response.status, content=response.body)
    if not isinstance(response.body, dict) or response.body.get("reset") is not True:
        log.warning("Team returned an invalid Space reset response")
        raise HTTPException(status_code=502, detail="Team returned an invalid Space reset response")
    return JSONResponse({"reset": True}, status_code=200)


if ADMIN_PROFILE == "local":
    app.add_api_route("/api/space", local_space_reset, methods=["DELETE"])


# ── Teams + Assistants: authenticated control plane for team. Every route stays under
# /api/ and outside OPEN_API, so the current profile's Supervisor session is required before the
# private bearer bridge can run. Admin has no Docker socket and preserves bounded Team JSON/status. ──
def _team_response(action):
    try:
        response = action()
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return JSONResponse(status_code=response.status, content=response.body)


async def _bounded_json_object(request: Request, max_bytes: int = team.MAX_JSON_BODY_BYTES) -> dict:
    """Read one JSON object without allowing an Action request to grow without bound."""
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="content type must be application/json")
    raw_length = request.headers.get("content-length")
    if raw_length is not None:
        if not raw_length.isascii() or not raw_length.isdigit():
            raise HTTPException(status_code=400, detail="invalid content length")
        if int(raw_length) > max_bytes:
            raise HTTPException(status_code=413, detail="request body too large")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise HTTPException(status_code=413, detail="request body too large")
    try:
        payload = json.loads(
            body,
            object_pairs_hook=chat_ws_common.unique_json_object,
            parse_constant=chat_ws_common._reject_json_constant,
        )
    except json.JSONDecodeError, UnicodeError, RecursionError, ValueError:
        raise HTTPException(status_code=400, detail="request body must be valid JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return payload


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


if ADMIN_PROFILE == "local":
    app.add_api_route("/api/model-providers", model_providers_status, methods=["GET"])
    app.add_api_route("/api/model-providers/{provider}", model_provider_configure, methods=["PUT"])
    app.add_api_route("/api/model-providers/{provider}", model_provider_delete, methods=["DELETE"])


MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = team.MAX_FILE_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES


class _MultipartBodyTooLargeError(OSError):
    pass


async def _bounded_multipart_file(request: Request) -> tuple[str, str, bytes]:
    """Accept exactly one bounded file part and return no filesystem path."""
    content_types = request.headers.getlist("content-type")
    if len(content_types) != 1 or content_types[0].partition(";")[0].strip().lower() != "multipart/form-data":
        raise HTTPException(status_code=415, detail="content type must be multipart/form-data")

    content_lengths = request.headers.getlist("content-length")
    if len(content_lengths) > 1:
        raise HTTPException(status_code=400, detail="invalid content length")
    if content_lengths:
        raw_length = content_lengths[0]
        if not raw_length.isascii() or not raw_length.isdigit():
            raise HTTPException(status_code=400, detail="invalid content length")
        if int(raw_length) > MAX_MULTIPART_BODY_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")

    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_MULTIPART_BODY_BYTES:
                raise _MultipartBodyTooLargeError
            yield chunk

    try:
        form = await MultiPartParser(
            request.headers,
            bounded_stream(),
            max_files=1,
            max_fields=0,
            max_part_size=1024,
        ).parse()
    except _MultipartBodyTooLargeError:
        raise HTTPException(status_code=413, detail="file upload too large") from None
    except MultiPartException:
        raise HTTPException(status_code=400, detail="invalid multipart body") from None

    try:
        items = form.multi_items()
        if len(items) != 1 or items[0][0] != "file" or not isinstance(items[0][1], UploadFile):
            raise HTTPException(status_code=400, detail="multipart body must contain only one file field")
        upload = items[0][1]
        try:
            filename = team.canonical_filename(upload.filename)
            media_type = team.canonical_media_type(upload.content_type)
        except team.TeamRequestError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        content = await upload.read(team.MAX_FILE_UPLOAD_BYTES + 1)
        if not content:
            raise HTTPException(status_code=400, detail="file must contain bytes")
        if len(content) > team.MAX_FILE_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")
        return filename, media_type, content
    finally:
        await form.close()


@app.get("/api/teams")
def teams_list():
    return _team_response(team.list_teams)


@app.post("/api/teams")
def teams_create(payload: dict):
    if set(payload) != {"team_name"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name")
    if not isinstance(payload["team_name"], str):
        raise HTTPException(status_code=400, detail="team name must be a string")
    team_name = payload["team_name"].strip()
    if not team_name:
        raise HTTPException(status_code=400, detail="team name required")
    team_id = team.to_team_id(team_name)
    if not team_id:
        raise HTTPException(status_code=400, detail="team name has no usable characters")
    response = _team_response(lambda: team.create(team_id, team_name))
    if 200 <= response.status_code < 300:
        log.info("team created: %s", team_id)
    return response


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

    if ADMIN_PROFILE == "local":
        record = state.get()
        try:
            password_ok = await asyncio.to_thread(
                auth.verify_password,
                password,
                record.get("salt", ""),
                record.get("password_hash", ""),
            )
        except TypeError, ValueError:
            log.warning("Admin password record is invalid")
            raise HTTPException(status_code=503, detail="Supervisor password verification is unavailable") from None
        if not password_ok:
            log.info("Team deletion password confirmation failed")
            raise HTTPException(status_code=403, detail="Supervisor password is incorrect")
    else:
        evidence = await _session_evidence(request.cookies)
        if evidence is None:
            raise HTTPException(status_code=401, detail="unauthenticated")
        verified = await account_identity.run_bounded(
            account_identity.verify_sudo_password,
            request.cookies.get(COOKIE, ""),
            password,
            _client_ip(request),
        )
        if verified.status in {401, 403}:
            raise HTTPException(status_code=403, detail="Supervisor password is incorrect")
        if verified.status == 429:
            raise HTTPException(status_code=429, detail="too many password attempts")
        if verified.status != 200:
            raise HTTPException(status_code=503, detail="Supervisor password verification is unavailable")

    return await run_in_threadpool(
        _team_response,
        lambda: team.destroy(team_id, team_name),
    )


@app.get("/api/teams/{team_id}/inference")
def team_inference_status(team_id: str):
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return _team_response(lambda: team.get_inference(team_id))


@app.put("/api/teams/{team_id}/inference")
async def team_inference_configure(team_id: str, request: Request):
    payload = await _bounded_json_object(request)
    return await run_in_threadpool(
        _team_response,
        lambda: team.configure_inference(team_id, payload),
    )


@app.websocket("/api/teams/{team_id}/chat/ws")
async def team_chat_ws(websocket: WebSocket, team_id: str):
    await chat_socket.serve(
        websocket,
        team_id,
        session_ok=_session_ok,
        request_scope=_team_session_scope,
        allowed_origins=_allowed_browser_origins,
        authenticate=_AUTHENTICATE_ACTION_REQUEST,
    )


@app.get("/api/teams/{team_id}/assistant-integrations")
def team_assistant_integrations(team_id: str):
    response = _team_response(lambda: integrations.list_assistant_integrations(team_id))
    response.headers["Cache-Control"] = "no-store"
    return response


async def team_assistant_integration_authorize(team_id: str, challenge_id: str, request: Request):
    payload = await _bounded_json_object(request)
    if payload:
        raise HTTPException(status_code=400, detail="request body must be an empty JSON object")
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


if ADMIN_PROFILE == "local":
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
    try:
        response = await asyncio.to_thread(
            integrations.disconnect_assistant_integration,
            team_id,
            assistant_id,
            integration_id,
        )
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
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
    hosted_callback = pending.callback_mode == "hosted"
    response.set_cookie(
        OAUTH_COOKIE,
        pending.session_binding,
        max_age=OAUTH_COOKIE_TTL,
        httponly=True,
        samesite="none" if hosted_callback else "lax",
        secure=hosted_callback,
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


@app.get("/api/assistants")
def assistants_list():
    return _team_response(team.list_assistants)


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


@app.delete("/api/teams/{team_id}/assistants/{assistant_id}")
def team_assistant_uninstall(team_id: str, assistant_id: str):
    return _team_response(lambda: team.uninstall_assistant(team_id, assistant_id))


@app.get("/api/notifications")
def notification_list():
    return notifications.list_notifications()


@app.post("/api/notifications/sync")
async def notification_sync():
    # Feed I/O plus local controller reconciliation must never block the ASGI event loop.
    return await run_in_threadpool(notifications.sync)


@app.post("/api/notifications/{notification_id}/read")
def notification_read(notification_id: str):
    try:
        return notifications.mark_read(notification_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="notification not found") from None


@app.post("/api/notifications/read-all")
def notifications_read_all():
    return notifications.mark_all_read()


@app.delete("/api/notifications")
def notifications_clear():
    return notifications.clear()


@app.get("/api/teams/{team_id}/files")
def team_files_list(team_id: str):
    return _team_response(lambda: team.list_files(team_id))


@app.post("/api/teams/{team_id}/files")
async def team_file_upload(team_id: str, request: Request):
    filename, media_type, content = await _bounded_multipart_file(request)
    return await run_in_threadpool(
        _team_response,
        lambda: team.upload_file(team_id, filename, media_type, content),
    )


@app.delete("/api/teams/{team_id}/files/{file_id}")
def team_file_delete(team_id: str, file_id: str):
    return _team_response(lambda: team.delete_file(team_id, file_id))


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
    async def spa(path: str):
        ui_root = UI_DIR.resolve()
        if path and not Path(path).is_absolute() and not path.startswith("/"):
            candidate = (ui_root / path).resolve()
            if candidate.is_relative_to(ui_root) and candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(ui_root / "index.html")
else:

    @app.get("/")
    async def no_ui():
        # Loud, not silent: APIs stay usable (tests/CI), humans are told exactly what to run.
        return PlainTextResponse("UI not built — build admin/frontend (npm run build).")
