"""Non-secret marketplace state — `integrations.json` on the panel's `/data` volume.

Holds only UI/enablement state (`{group: {enabled, updated}}`), never secrets — those live in `.env`
(envfile.py). Mirrors the gateway's prefs.json contract: a MISSING file reads as `{}` (fresh), but a
CORRUPT file RAISES (fail-fast, no silent reset). `/data` is a writable volume, so the atomic
tmp+rename works normally here (unlike the single-file `.env` bind that needs envfile.write's EROFS
fallback).

The live-apply half (recreating a sidecar via shimpz-driver so a saved secret takes effect) is
Phase C2 — it lands here as `recreate()` when the panel gets driver wiring. C1 is store-only.
"""

import http.client
import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("shimpz-admin")

STORE_PATH = Path(os.environ.get("SHIMPZ_INTEGRATIONS_STORE") or "/data/integrations.json")


def read():
    """Full store dict. Missing file → {} (fresh). Corrupt JSON → raise (fail-loud)."""
    if not STORE_PATH.exists():
        return {}
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise RuntimeError(f"integrations store {STORE_PATH} is corrupt — refusing to read: {e}") from None
    if not isinstance(data, dict):
        raise RuntimeError(f"integrations store {STORE_PATH} is not a JSON object")
    return data


def _write(state):
    """Atomically write the store (tmp-in-same-dir + rename). Only OSError is tolerated (log-warn)."""
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_name(f".{STORE_PATH.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(STORE_PATH)
    except OSError as e:
        log.warning("integrations store write failed: %s", e)


def get_group(group):
    """State for one group (may be {})."""
    return read().get(group, {})


def set_group(group, *, enabled):
    """Persist a group's enabled flag + an updated timestamp."""
    state = read()
    state[group] = {"enabled": bool(enabled), "updated": int(time.time())}
    _write(state)
    return state[group]


def recreate(service, env):
    """POST a stateless sidecar's new env to shimpz-driver's /v1/stack/recreate → (ok, body).

    The panel holds the secrets but no docker.sock; the driver holds the socket but no `.env` —
    the secret transits this ONE authenticated call. NEVER raises: a save has already landed in `.env`,
    so a failed live-apply is reported (ok=False) for the UI, not fatal. Mirrors `shimpzdriver.sh`.
    """
    url = os.environ.get("SHIMPZ_DRIVER_URL", "http://shimpz-driver:7070")
    token_file = os.environ.get("SHIMPZ_DRIVER_TOKEN_FILE", "/run/shimpz-driver/token")
    parsed = urlparse(url)
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 7070, timeout=90)
        conn.request(
            "POST",
            "/v1/stack/recreate",
            json.dumps({"service": service, "env": env}),
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        body = json.loads(resp.read() or b"{}")
        conn.close()
    except (OSError, json.JSONDecodeError) as e:
        log.warning("recreate %s failed to reach the driver: %s", service, e)
        return False, {"error": f"could not reach the driver: {e}"}
    ok = 200 <= resp.status < 300
    log.info("recreate %s -> HTTP %s ok=%s", service, resp.status, ok)
    return ok, body
