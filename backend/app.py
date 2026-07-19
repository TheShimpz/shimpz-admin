"""The local Admin API and static UI server running in the `shimpz-admin` container.

Auth (persistent): first run has NO password — the "create admin password" screen is reachable
while uninitialized (the panel binds loopback / sits behind Cloudflare Access; the window closes
forever the instant a password is set). After that, a signed session cookie (`shimpz_admin`) is the
only way in. Query parameters never grant a session.

The static SPA + the auth endpoints are open (the login form carries no secret); everything that
reads or writes the keyset requires a valid session. Secrets flow IN via /api/validate + /api/apply
and are never logged; reads expose only `set` + masked last4 (envfile.mask).

This process holds NO docker.sock and never runs `docker compose`: it edits `.env` and reports
config only. Booting the stack is `scripts/shimpz-init && docker compose up`; recreating a service
after a config change is the marketplace's job (via shimpz-driver), not this app's.
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adminstore
import auth
import catalog
import chat_ws
import driver_proxy
import envfile
import integrations
import keyset
import modelproviders
import notifications
import teams
import validate_live

log = logging.getLogger("shimpz-admin")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

TEAM_CREDENTIALS_ENABLED = os.environ.get("SHIMPZ_TEAM_CREDENTIALS_ENABLED", "1").strip() == "1"

REPO = Path(os.environ.get("SHIMPZ_REPO") or Path(__file__).resolve().parents[3])
ENV_PATH = REPO / ".env"
EXAMPLE_PATH = REPO / ".env.example"  # the scaffolding baseline (mounted :ro); see `_configured`
UI_DIR = Path(__file__).resolve().parent.parent / "frontend" / "build"
COOKIE = "shimpz_admin"
MIN_PASSWORD_LEN = 12
MAX_TEAM_DELETE_BODY_BYTES = 8 * 1024
MAX_ADMIN_PASSWORD_CHARS = 4 * 1024

# Boot preflight: an upgraded install must explicitly remove and rotate deprecated global Brain keys.
# The exception names only offending variable names, never their values.
envfile.read(ENV_PATH)

# Open surface: the SPA shell (served for any non-/api path) + these auth endpoints. Everything
# else under /api/ needs a session.
OPEN_API = frozenset({"/api/session", "/api/login", "/api/logout", "/api/admin/setup"})

app = FastAPI(title="shimpz-admin", docs_url=None, redoc_url=None, openapi_url=None)


def _is_https(request):
    xfp = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or xfp == "https"


def _set_session(resp, request, token):
    resp.set_cookie(
        COOKIE, token, max_age=auth.TTL, httponly=True, samesite="strict", secure=_is_https(request), path="/"
    )


def _session_ok(cookies):
    return auth.verify_session(adminstore.get().get("session_secret", ""), cookies.get(COOKIE, ""))


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
async def logout():
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


def _field_view(f, values):
    """The masked, UI-safe view of one keyset field (never the whole secret)."""
    return {
        "key": f["key"],
        "group": f["group"],
        "required": f["required"],
        "generated": f["generate"],
        "secret": f["secret"],
        "set": bool(values.get(f["key"], "").strip()),
        "masked": envfile.mask(values.get(f["key"], "")) if f["secret"] else values.get(f["key"], ""),
        "help": f["help"],
        "live": bool(f["validator"] and f["validator"].startswith("live_")),
        "guide": keyset.GUIDES.get(f["key"]),
    }


def _example_defaults():
    """The `.env.example` scaffolding values — the baseline a fresh `cp .env.example .env` starts from.

    Mounted read-only into the container (docker-compose.yml). Read per request (a tiny file); a card
    reads as "configured" only when a field DIFFERS from its default here (see `_configured`). Absent
    → `{}` (every field then compares against ""); the compose mount is pinned by a test.
    """
    return envfile.read(EXAMPLE_PATH) if EXAMPLE_PATH.exists() else {}


def _configured(fields, values, defaults):
    """True when the user configured this card — a field set to a non-default, non-generated value.

    A fresh install is `cp .env.example .env`, so only a value the user changed or provided counts.
    Generated values and unchanged scaffolding defaults do not mark an integration as configured.
    """
    return any(
        not f["generated"] and (v := values.get(f["key"], "").strip()) and v != defaults.get(f["key"], "").strip()
        for f in fields
    )


def _persist(updates):
    """Validate then write `updates` to `.env` (with generated internals). → (applied, results, generated).

    A bad non-empty value blocks the whole batch (applied=False, nothing written); an empty optional
    doesn't. Shared by /api/apply and /api/integrations/{group}.
    """
    results, failed = {}, False
    for k, v in updates.items():
        try:
            ok, detail = validate_live.validate(k, v)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None
        results[k] = {"ok": ok, "detail": detail}
        failed = failed or (not ok and v.strip())
    if failed:
        return False, results, []
    merged = envfile.merge(envfile.read(ENV_PATH), updates)
    generated = keyset.generate_internal(merged)
    merged.update(generated)
    envfile.write(ENV_PATH, merged)
    return True, results, sorted(generated)


def _maybe_recreate(group, *, enabled=True):
    """Make a saved integration take effect live: recreate its consuming sidecar via shimpz-driver.

    Only the stateless capability sidecars carry a `recreate_target`; everything else just reports that
    it applies on the next restart. Disabling recreates the sidecar INERT (empty secrets). Never fatal:
    the `.env` write already succeeded, so a failed apply is surfaced (ok=False), never raised.
    """
    target = catalog.entry(group)["recreate_target"]
    if not target:
        return {"target": None, "note": "saved; applies on the next restart of the affected service"}
    env = catalog.container_env_for(group, envfile.read(ENV_PATH))
    if not enabled:
        env = dict.fromkeys(env, "")  # disable = recreate the sidecar with empty secrets (inert boot)
    ok, body = integrations.recreate(target, env)
    detail = body.get("health") or body.get("error") or ("recreated" if ok else "apply failed")
    return {"target": target, "ok": ok, "detail": detail}


@app.get("/api/state")
async def state():
    values = envfile.read(ENV_PATH)
    fields = [_field_view(f, values) for f in keyset.SCHEMA]
    return {"fields": fields, "env_path": str(ENV_PATH), "env_exists": ENV_PATH.exists()}


@app.get("/api/integrations")
async def integrations_list():
    values = envfile.read(ENV_PATH)
    defaults = _example_defaults()
    store = integrations.read()
    out = []
    for group, meta in catalog.CATALOG.items():
        fields = [_field_view(keyset.BY_KEY[k], values) for k in catalog.keys_for(group)]
        configured = _configured(fields, values, defaults)
        out.append(
            {
                "group": group,
                "public_name": meta["public_name"],
                "category": meta["category"],
                "blurb": meta["blurb"],
                "reconfigurable": meta["reconfigurable"],
                "auto_apply": meta["recreate_target"] is not None,
                "configured": configured,
                "enabled": store.get(group, {}).get("enabled", configured),
                "fields": fields,
            }
        )
    return {"integrations": out, "categories": list(catalog.CATEGORIES)}


@app.post("/api/integrations/{group}")
async def integrations_save(group: str, payload: dict):
    try:
        catalog.entry(group)
        group_keys = set(catalog.keys_for(group))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    updates = {str(k): str(v) for k, v in dict(payload.get("values", {})).items()}
    stray = sorted(k for k in updates if k not in group_keys)
    if stray:
        raise HTTPException(status_code=400, detail=f"keys not in integration {group!r}: {stray}")
    applied, results, generated = _persist(updates)
    if not applied:
        return JSONResponse(status_code=400, content={"applied": False, "results": results})
    integrations.set_group(group, enabled=True)
    log.info("integration %s saved (%d keys, +%d generated)", group, len(updates), len(generated))
    return {"applied": True, "results": results, "generated": generated, "recreate": _maybe_recreate(group)}


@app.post("/api/integrations/{group}/toggle")
async def integrations_toggle(group: str, payload: dict):
    try:
        catalog.entry(group)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    enabled = bool(payload.get("enabled"))
    integrations.set_group(group, enabled=enabled)
    log.info("integration %s toggled -> enabled=%s", group, enabled)
    return {"enabled": enabled, "recreate": _maybe_recreate(group, enabled=enabled)}


@app.post("/api/validate")
async def validate(payload: dict):
    key, value = str(payload.get("key", "")), str(payload.get("value", ""))
    try:
        ok, detail = validate_live.validate(key, value)
    except ValueError as e:  # unknown key — the fail-fast contract
        raise HTTPException(status_code=400, detail=str(e)) from None
    log.info("validate %s -> %s", key, "ok" if ok else "fail")  # never the value
    return {"key": key, "ok": ok, "detail": detail}


@app.post("/api/apply")
async def apply(payload: dict):
    updates = {str(k): str(v) for k, v in dict(payload.get("values", {})).items()}
    applied, results, generated = _persist(updates)
    if not applied:
        return JSONResponse(status_code=400, content={"applied": False, "results": results})
    log.info("applied %d keys (+%d generated) -> %s", len(updates), len(generated), ENV_PATH)
    return {"applied": True, "results": results, "generated": generated}


# ── Teams + Assistants: authenticated control plane for team-driver. Every route stays under
# /api/ and outside OPEN_API, so the signed local Admin session is required before the private bearer
# bridge can run. The Admin has no Docker socket and preserves bounded driver JSON/status exactly. ──
def _team_driver_response(action):
    try:
        response = action()
    except teams.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return JSONResponse(status_code=response.status, content=response.body)


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
        payload = json.loads(body)
    except json.JSONDecodeError, UnicodeError, RecursionError:
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


def _driver_proxy_response(action):
    """Return only bounded JSON received from team-driver; normalize local validation failures."""
    try:
        response = action()
    except driver_proxy.ProxyRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return JSONResponse(status_code=response.status, content=response.body)


# Driver configuration stays out of `.env`/keyset: these session-gated routes are a stateless,
# JSON-only pass-through to team-driver's per-Team control plane.
@app.get("/api/teams/{team_id}/drivers/{driver_id}")
def team_driver_get(team_id: str, driver_id: str):
    return _driver_proxy_response(lambda: driver_proxy.get_driver(team_id, driver_id))


@app.post("/api/teams/{team_id}/drivers/{driver_id}/credentials")
def team_driver_credential_create(team_id: str, driver_id: str, payload: dict):
    return _driver_proxy_response(lambda: driver_proxy.create_credential(team_id, driver_id, payload))


@app.put("/api/teams/{team_id}/drivers/{driver_id}/credentials/{credential_id}")
def team_driver_credential_replace(team_id: str, driver_id: str, credential_id: str, payload: dict):
    return _driver_proxy_response(lambda: driver_proxy.replace_credential(team_id, driver_id, credential_id, payload))


@app.delete("/api/teams/{team_id}/drivers/{driver_id}/credentials/{credential_id}")
def team_driver_credential_delete(team_id: str, driver_id: str, credential_id: str, payload: dict):
    return _driver_proxy_response(lambda: driver_proxy.delete_credential(team_id, driver_id, credential_id, payload))


@app.post("/api/teams/{team_id}/drivers/{driver_id}/credentials/{credential_id}/verify")
def team_driver_credential_verify(team_id: str, driver_id: str, credential_id: str, payload: dict | None = None):
    return _driver_proxy_response(
        lambda: driver_proxy.verify_credential(team_id, driver_id, credential_id, payload or {})
    )


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
        if ".." not in path.split("/"):
            candidate = UI_DIR / path
            if path and candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(UI_DIR / "index.html")
else:

    @app.get("/")
    async def no_ui():
        # Loud, not silent: APIs stay usable (tests/CI), humans are told exactly what to run.
        return PlainTextResponse("UI not built — build apps/admin/frontend (npm run build).")
