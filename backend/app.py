"""The local Admin API and static UI server running in the `shimpz-admin` container.

Auth (persistent): first run has NO password — the "create admin password" screen is reachable
while uninitialized (the panel binds loopback / sits behind Cloudflare Access; the window closes
forever the instant a password is set). After that, a signed session cookie (`shimpz_admin`) is the
only way in. Query parameters never grant a session.

The static SPA + the auth endpoints are open (the login form carries no secret); every Team,
Assistant, model-provider, OAuth, notification, and chat endpoint requires a valid session. This
process holds no Docker socket and has no host configuration write surface.
"""

import asyncio
import json
import logging
import os
import sys
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adminstore
import auth
import chat_ws
import localchat
import modelproviders
import notifications
import oauth_handoff
import teams

log = logging.getLogger("shimpz-admin")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

TEAM_CREDENTIALS_ENABLED = os.environ.get("SHIMPZ_TEAM_CREDENTIALS_ENABLED", "1").strip() == "1"

UI_DIR = Path(__file__).resolve().parent.parent / "frontend" / "build"
COOKIE = "shimpz_admin"
OAUTH_COOKIE = "shimpz_oauth_binding"
OAUTH_COOKIE_PATH = "/api/oauth/cloudflare"
OAUTH_COOKIE_TTL = 300
OAUTH_START_PATH = "/api/oauth/cloudflare/start"


def _configured_loopback_port() -> int:
    value = os.environ.get("SHIMPZ_ADMIN_LOOPBACK_PORT", "4600").strip()
    if not value.isascii() or not value.isdecimal():
        raise RuntimeError("invalid Admin loopback port")
    port = int(value)
    if not 1 <= port <= 65535:
        raise RuntimeError("invalid Admin loopback port")
    return port


OAUTH_LOOPBACK_PORT = _configured_loopback_port()
OAUTH_ORIGINS = {
    "loopback": f"http://127.0.0.1:{OAUTH_LOOPBACK_PORT}",
    "hosted": "https://local.shimpz.com",
}
MIN_PASSWORD_LEN = 12
MAX_TEAM_DELETE_BODY_BYTES = 8 * 1024
MAX_ADMIN_PASSWORD_CHARS = 4 * 1024

# Open surface: the SPA shell (served for any non-/api path) + these auth endpoints. Everything
# else under /api/ needs a session.
OPEN_API = frozenset(
    {
        "/api/session",
        "/api/login",
        "/api/logout",
        "/api/admin/setup",
        "/api/oauth/cloudflare/start",
        "/api/oauth/cloudflare/callback",
    }
)

app = FastAPI(title="shimpz-admin", docs_url=None, redoc_url=None, openapi_url=None)
OAUTH_HANDOFFS = oauth_handoff.OAuthHandoffStore()


def _is_https(request):
    xfp = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or xfp == "https"


def _oauth_callback_mode() -> str:
    mode = os.environ.get("SHIMPZ_OAUTH_CALLBACK_MODE", "loopback").strip()
    if mode not in OAUTH_ORIGINS:
        raise RuntimeError("invalid OAuth callback mode")
    return mode


def _oauth_origin() -> str:
    return OAUTH_ORIGINS[_oauth_callback_mode()]


def _is_oauth_origin(request: Request) -> bool:
    origin = _oauth_origin()
    if origin == OAUTH_ORIGINS["loopback"]:
        return (
            request.url.scheme == "http"
            and request.url.hostname == "127.0.0.1"
            and request.url.port == OAUTH_LOOPBACK_PORT
        )
    return _is_https(request) and request.url.hostname == "local.shimpz.com" and request.url.port is None


def _set_session(resp, request, token):
    resp.set_cookie(
        COOKIE, token, max_age=auth.TTL, httponly=True, samesite="strict", secure=_is_https(request), path="/"
    )


def _session_ok(cookies):
    return auth.verify_session(adminstore.get().get("session_secret", ""), cookies.get(COOKIE, ""))


def _oauth_chat_redirect(failure: str = "") -> RedirectResponse:
    """Leave provider query data behind and return to the token-free SPA URL."""
    if failure not in {"", "start-failed", "callback-failed"}:
        raise RuntimeError("invalid OAuth redirect failure")
    location = "/chat" if not failure else f"/chat?oauth={failure}"
    response = RedirectResponse(location, status_code=303)
    response.delete_cookie(OAUTH_COOKIE, path=OAUTH_COOKIE_PATH)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.middleware("http")
async def _gate(request: Request, call_next):
    """Dual-mode gate: static SPA + auth endpoints open; the rest needs a signed session cookie."""
    path = request.url.path

    # Static SPA + assets (login form has no secret) and the open auth endpoints.
    if not path.startswith("/api/") or path in OPEN_API:
        return await call_next(request)

    # Everything else under /api/ requires a valid session.
    if not _session_ok(request.cookies):
        return JSONResponse({"detail": "unauthenticated"}, status_code=401)
    return await call_next(request)


@app.get("/api/session")
async def session(request: Request):
    return {
        "authenticated": _session_ok(request.cookies),
        "initialized": adminstore.is_initialized(),
        "features": {"teamCredentials": TEAM_CREDENTIALS_ENABLED},
    }


@app.post("/api/login")
async def login(request: Request, payload: dict):
    if not adminstore.is_initialized():
        raise HTTPException(status_code=409, detail="no admin password set yet — create one first")
    rec = adminstore.get()
    if not auth.verify_password(str(payload.get("password", "")), rec.get("salt", ""), rec.get("password_hash", "")):
        log.info("login failed")  # never the password
        raise HTTPException(status_code=401, detail="wrong password")
    resp = JSONResponse({"ok": True})
    _set_session(resp, request, auth.issue_session(rec["session_secret"]))
    log.info("login ok")
    return resp


@app.post("/api/logout")
async def logout(request: Request):
    session_token = request.cookies.get(COOKIE, "")
    if session_token:
        with suppress(oauth_handoff.OAuthHandoffError):
            OAUTH_HANDOFFS.cancel_session(session_token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.post("/api/admin/setup")
async def admin_setup(request: Request, payload: dict):
    if adminstore.is_initialized():
        raise HTTPException(status_code=409, detail="admin password already set")
    password = str(payload.get("password", ""))
    if len(password) < MIN_PASSWORD_LEN:
        raise HTTPException(status_code=400, detail=f"password must be at least {MIN_PASSWORD_LEN} characters")
    adminstore.set_password(password)
    resp = JSONResponse({"ok": True})
    _set_session(resp, request, auth.issue_session(adminstore.get()["session_secret"]))
    log.info("admin password created")
    return resp


# ── Teams + Assistants: authenticated control plane for team-driver. Every route stays under
# /api/ and outside OPEN_API, so the signed local Admin session is required before the private bearer
# bridge can run. The Admin has no Docker socket and preserves bounded driver JSON/status exactly. ──
def _team_driver_response(action):
    try:
        response = action()
    except teams.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return JSONResponse(status_code=response.status, content=response.body)


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def _reject_json_constant(_value: str) -> object:
    raise ValueError("non-finite JSON number")


async def _bounded_json_object(request: Request, max_bytes: int = teams.MAX_JSON_BODY_BYTES) -> dict:
    """Read one JSON object without allowing a Power request to grow without bound."""
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
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except json.JSONDecodeError, UnicodeError, RecursionError, ValueError:
        raise HTTPException(status_code=400, detail="request body must be valid JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return payload


@app.get("/api/model-providers")
def model_providers_status():
    """Return masked local provider state; cleartext keys never leave the Admin backend."""
    return modelproviders.status()


@app.put("/api/model-providers/{provider}")
async def model_provider_configure(provider: str, request: Request):
    payload = await _bounded_json_object(request)
    if set(payload) != {"api_key"}:
        raise HTTPException(status_code=400, detail="request body must contain only api_key")
    try:
        return await asyncio.to_thread(modelproviders.configure, provider, payload["api_key"])
    except modelproviders.ModelProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except modelproviders.ModelProviderUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@app.delete("/api/model-providers/{provider}")
def model_provider_delete(provider: str):
    try:
        return modelproviders.remove(provider)
    except modelproviders.ModelProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = teams.MAX_FILE_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES


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
            filename = teams.canonical_filename(upload.filename)
            media_type = teams.canonical_media_type(upload.content_type)
        except teams.TeamRequestError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        content = await upload.read(teams.MAX_FILE_UPLOAD_BYTES + 1)
        if not content:
            raise HTTPException(status_code=400, detail="file must contain bytes")
        if len(content) > teams.MAX_FILE_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")
        return filename, media_type, content
    finally:
        await form.close()


@app.get("/api/teams")
def teams_list():
    return _team_driver_response(teams.list_teams)


@app.post("/api/teams")
def teams_create(payload: dict):
    if set(payload) != {"team_name"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name")
    if not isinstance(payload["team_name"], str):
        raise HTTPException(status_code=400, detail="team name must be a string")
    team_name = payload["team_name"].strip()
    if not team_name:
        raise HTTPException(status_code=400, detail="team name required")
    team_id = teams.to_team_id(team_name)
    if not team_id:
        raise HTTPException(status_code=400, detail="team name has no usable characters")
    response = _team_driver_response(lambda: teams.create(team_id, team_name))
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
    if not 1 <= len(password) <= MAX_ADMIN_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="admin password is invalid")

    record = adminstore.get()
    try:
        password_ok = await asyncio.to_thread(
            auth.verify_password,
            password,
            record.get("salt", ""),
            record.get("password_hash", ""),
        )
    except TypeError, ValueError:
        log.warning("admin password record is invalid")
        raise HTTPException(status_code=503, detail="admin password verification is unavailable") from None
    if not password_ok:
        log.info("Team deletion password confirmation failed")
        raise HTTPException(status_code=403, detail="admin password is incorrect")

    return await run_in_threadpool(
        _team_driver_response,
        lambda: teams.destroy(team_id, team_name),
    )


@app.get("/api/teams/{team_id}/inference")
def team_inference_status(team_id: str):
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return _team_driver_response(lambda: teams.get_inference(team_id))


@app.put("/api/teams/{team_id}/inference")
async def team_inference_configure(team_id: str, request: Request):
    payload = await _bounded_json_object(request)
    return await run_in_threadpool(
        _team_driver_response,
        lambda: teams.configure_inference(team_id, payload),
    )


@app.websocket("/api/teams/{team_id}/chat/ws")
async def team_chat_ws(websocket: WebSocket, team_id: str):
    await chat_ws.serve(websocket, team_id, session_ok=_session_ok)


@app.put("/api/teams/{team_id}/assistant-secrets")
async def team_assistant_secrets_replace(team_id: str, request: Request):
    payload = await _bounded_json_object(request, teams.MAX_SECRET_JSON_BODY_BYTES)
    return await run_in_threadpool(
        _team_driver_response,
        lambda: localchat.replace_secrets(team_id, payload),
    )


@app.get("/api/teams/{team_id}/assistant-approvals")
def team_assistant_approvals(team_id: str):
    return _team_driver_response(lambda: localchat.approval_inventory(team_id))


@app.delete("/api/teams/{team_id}/assistant-approvals")
async def team_assistant_approvals_revoke(team_id: str):
    return await run_in_threadpool(
        _team_driver_response,
        lambda: localchat.revoke_approvals(team_id),
    )


@app.get("/api/teams/{team_id}/assistant-accounts")
def team_assistant_accounts(team_id: str):
    response = _team_driver_response(lambda: teams.list_assistant_accounts(team_id))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/teams/{team_id}/assistant-accounts/challenges/{challenge_id}/authorize")
async def team_assistant_account_authorize(team_id: str, challenge_id: str, request: Request):
    payload = await _bounded_json_object(request)
    if payload:
        raise HTTPException(status_code=400, detail="request body must be an empty JSON object")
    session_token = request.cookies.get(COOKIE, "")
    if not _session_ok(request.cookies):
        raise HTTPException(status_code=401, detail="unauthenticated")
    try:
        canonical_team = teams.canonical_team_id(team_id)
        canonical_challenge = teams.canonical_challenge_id(challenge_id)
        handoff = OAUTH_HANDOFFS.issue(
            team_id=canonical_team,
            challenge_id=canonical_challenge,
            admin_session=session_token,
        )
    except teams.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except oauth_handoff.OAuthHandoffError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    authorization_url = _oauth_origin() + OAUTH_START_PATH + "?" + urlencode({"handoff": handoff})
    return JSONResponse(
        {"authorization_url": authorization_url},
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@app.delete("/api/teams/{team_id}/assistant-accounts/{assistant_id}/{account_id}")
async def team_assistant_account_disconnect(team_id: str, assistant_id: str, account_id: str):
    try:
        response = await asyncio.to_thread(
            teams.disconnect_assistant_account,
            team_id,
            assistant_id,
            account_id,
        )
    except teams.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if response.status == 204 and not response.body:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return JSONResponse(response.body, status_code=response.status, headers={"Cache-Control": "no-store"})


@app.get("/api/oauth/cloudflare/start")
async def oauth_cloudflare_start(request: Request, handoff: str = ""):
    if not _is_oauth_origin(request):
        return _oauth_chat_redirect("start-failed")
    try:
        pending = OAUTH_HANDOFFS.consume(handoff)
        result = await asyncio.to_thread(
            teams.start_assistant_account_authorization,
            pending.team_id,
            pending.challenge_id,
            pending.session_binding,
            _oauth_callback_mode(),
        )
    except oauth_handoff.OAuthHandoffError, teams.TeamRequestError:
        return _oauth_chat_redirect("start-failed")
    if result.status != 200:
        log.info("OAuth authorization start rejected (HTTP %s)", result.status)
        return _oauth_chat_redirect("start-failed")
    authorization_url = result.body.get("authorization_url")
    if not isinstance(authorization_url, str):
        return _oauth_chat_redirect("start-failed")
    response = RedirectResponse(authorization_url, status_code=303)
    hosted_callback = _oauth_origin() == OAUTH_ORIGINS["hosted"]
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
        return _oauth_chat_redirect("callback-failed")
    pairs = list(request.query_params.multi_items())
    if len(pairs) != 2 or {key for key, _value in pairs} != {"state", "claim"}:
        return _oauth_chat_redirect("callback-failed")
    query = dict(pairs)
    binding = request.cookies.get(OAUTH_COOKIE, "")
    try:
        result = await asyncio.to_thread(
            teams.complete_cloudflare_oauth_callback,
            state=query["state"],
            claim=query["claim"],
            session_binding=binding,
        )
    except teams.TeamRequestError:
        return _oauth_chat_redirect("callback-failed")
    if result.status != 200:
        log.info("OAuth callback rejected (HTTP %s)", result.status)
        return _oauth_chat_redirect("callback-failed")
    return _oauth_chat_redirect()


@app.get("/api/assistants")
def assistants_list():
    return _team_driver_response(teams.list_assistants)


@app.get("/api/teams/{team_id}/assistants")
def team_assistants_list(team_id: str):
    return _team_driver_response(lambda: teams.list_installed_assistants(team_id))


@app.get("/api/teams/{team_id}/assistants/{assistant_id}/help")
def team_assistant_help(team_id: str, assistant_id: str, locale: str = "en"):
    response = _team_driver_response(lambda: teams.assistant_help(team_id, assistant_id, locale))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/teams/{team_id}/assistants")
async def team_assistant_install(team_id: str, request: Request):
    payload = await _bounded_json_object(request)
    return await run_in_threadpool(
        _team_driver_response,
        lambda: teams.install_assistant(team_id, payload),
    )


@app.delete("/api/teams/{team_id}/assistants/{assistant_id}")
def team_assistant_uninstall(team_id: str, assistant_id: str):
    return _team_driver_response(lambda: teams.uninstall_assistant(team_id, assistant_id))


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
    return _team_driver_response(lambda: teams.list_files(team_id))


@app.post("/api/teams/{team_id}/files")
async def team_file_upload(team_id: str, request: Request):
    filename, media_type, content = await _bounded_multipart_file(request)
    return await run_in_threadpool(
        _team_driver_response,
        lambda: teams.upload_file(team_id, filename, media_type, content),
    )


@app.delete("/api/teams/{team_id}/files/{file_id}")
def team_file_delete(team_id: str, file_id: str):
    return _team_driver_response(lambda: teams.delete_file(team_id, file_id))


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
        return PlainTextResponse("UI not built — build apps/admin/frontend (npm run build).")
