"""The admin panel API + static UI server (runs as the `shimpz-admin` container, or via scripts/shimpz-setup).

Auth (persistent): first run has NO password — the "create admin password" screen is reachable
while uninitialized (the panel binds loopback / sits behind Cloudflare Access; the window closes
forever the instant a password is set). After that, a signed session cookie (`shimpz_admin`) is the
only way in. A legacy `SHIMPZ_SETUP_TOKEN`, if set, still bridges `?token=` → a session WHILE
uninitialized (defense-in-depth for multi-user hosts); once a password exists it is dead.

The static SPA + the auth endpoints are open (the login form carries no secret); everything that
reads or writes the keyset requires a valid session. Secrets flow IN via /api/validate + /api/apply
and are never logged; reads expose only `set` + masked last4 (envfile.mask).

This process holds NO docker.sock and never runs `docker compose`: it edits `.env` and reports
config only. Booting the stack is `scripts/shimpz-init && docker compose up`; recreating a service
after a config change is the marketplace's job (via shimpz-driver), not this app's.
"""

import hmac
import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adminstore
import auth
import capsules
import catalog
import envfile
import integrations
import keyset
import validate_live

log = logging.getLogger("shimpz-admin")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

# Optional bootstrap token: shimpz-setup mints one; the shimpz-admin container normally does not. Its
# ONLY power is bridging `?token=` → a session while no password is set. Never a raise if absent.
SETUP_TOKEN = os.environ.get("SHIMPZ_SETUP_TOKEN", "").strip()

REPO = Path(os.environ.get("SHIMPZ_REPO") or Path(__file__).resolve().parents[3])
ENV_PATH = REPO / ".env"
EXAMPLE_PATH = REPO / ".env.example"  # the scaffolding baseline (mounted :ro); see `_configured`
UI_DIR = Path(__file__).resolve().parent.parent / "frontend" / "build"
COOKIE = "shimpz_admin"
MIN_PASSWORD_LEN = 12

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

    # (1) legacy shimpz-setup bridge — a matching ?token= grants a session, but ONLY while uninitialized.
    tok = request.query_params.get("token", "")
    if tok and SETUP_TOKEN and not adminstore.is_initialized():
        if not hmac.compare_digest(tok, SETUP_TOKEN):
            return PlainTextResponse("invalid setup token", status_code=401)
        resp = RedirectResponse(url=path)
        _set_session(resp, request, auth.issue_session(adminstore.ensure_secret()))
        return resp

    # (2) static SPA + assets (login form has no secret) and (3) the open auth endpoints
    if not path.startswith("/api/") or path in OPEN_API:
        return await call_next(request)

    # (4) everything else under /api/ → valid session required
    if not _session_ok(request.cookies):
        return JSONResponse({"detail": "unauthenticated"}, status_code=401)
    return await call_next(request)


@app.get("/api/session")
async def session(request: Request):
    return {"authenticated": _session_ok(request.cookies), "initialized": adminstore.is_initialized()}


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
    if SETUP_TOKEN and not hmac.compare_digest(str(payload.get("bootstrap_token", "")), SETUP_TOKEN):
        raise HTTPException(status_code=401, detail="bootstrap token required")
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

    A fresh install is `cp .env.example .env`, so a card's non-secret defaults (e.g.
    `IPROYAL_PROXY_PORT_HTTP=12323`, `SHIMPZ_PROXY=auto`) are present but must NOT read as "configured" —
    only a value the user changed or provided (a proxy password, an R2 bucket) counts. This is what
    fixes the IPRoyal/proxy card wrongly reading configured on a fresh install.
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
                "logo": meta["logo"],
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


# ── Capsules: the authenticated control plane for capsule-driver. Session-gated by the middleware
# (under /api/, not in OPEN_API); the panel holds no docker.sock — it POSTs to capsule-driver, which
# provisions the isolated brain. This is the "create a Capsule, then configure it here" surface. ──
@app.get("/api/capsules")
async def capsules_list():
    ok, body = capsules.list_capsules()
    if not ok:
        raise HTTPException(status_code=502, detail=body.get("error", "capsule-driver unreachable"))
    return body


@app.post("/api/capsules")
async def capsules_create(payload: dict):
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="capsule name required")
    cid = capsules.to_cid(name)
    if not cid:
        raise HTTPException(status_code=400, detail="capsule name has no usable characters")
    ok, body = capsules.create(cid, name)
    if not ok:
        raise HTTPException(status_code=502, detail=body.get("error", "capsule create failed"))
    log.info("capsule created: %s", cid)
    return body


@app.delete("/api/capsules/{cid}")
async def capsules_destroy(cid: str):
    ok, body = capsules.destroy(capsules.to_cid(cid))
    if not ok:
        raise HTTPException(status_code=502, detail=body.get("error", "capsule destroy failed"))
    return body


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def unknown_api(path: str):
    """Keep unknown API paths out of the SPA fallback and fail honestly."""
    raise HTTPException(status_code=404, detail=f"unknown API endpoint: /api/{path}")


if UI_DIR.is_dir():
    # SPA serve: return a real asset if the path maps to one, else fall back to index.html so a
    # client-routed view (e.g. /capsules) works on a direct load / refresh — not just via in-app nav
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
