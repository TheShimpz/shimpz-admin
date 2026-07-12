"""Thin client for shimpz-driver's brain-login endpoints — the Claude-subscription OAuth bridge.

The panel holds the admin session but NEVER the docker.sock; the driver holds the socket but
never the panel's secrets — so the panel drives the brain's `shimpz-login` OAuth flow through this ONE
authenticated hop, the SAME split as `integrations.recreate` (Phase C2 wiring: SHIMPZ_DRIVER_URL,
SHIMPZ_DRIVER_TOKEN_FILE). NEVER raises: an unreachable driver is reported as (False, {...}) for the
UI, never a 500. The pasted OAuth code transits `code()` but is NEVER logged here (only method+path).
"""

import http.client
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("shimpz-admin")


def _call(method, path, body=None):
    """One authenticated call to shimpz-driver → (ok, parsed_body). Never raises. Mirrors integrations.recreate."""
    url = os.environ.get("SHIMPZ_DRIVER_URL", "http://shimpz-driver:7070")
    token_file = os.environ.get("SHIMPZ_DRIVER_TOKEN_FILE", "/run/shimpz-driver/token")
    parsed = urlparse(url)
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 7070, timeout=30)
        conn.request(
            method,
            path,
            json.dumps(body) if body is not None else None,
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        parsed_body = json.loads(resp.read() or b"{}")
        conn.close()
    except (OSError, json.JSONDecodeError) as e:
        log.warning("brain-login %s %s failed to reach the driver: %s", method, path, e)
        return False, {"error": f"could not reach the driver: {e}"}
    ok = 200 <= resp.status < 300
    log.info("brain-login %s %s -> HTTP %s ok=%s", method, path, resp.status, ok)  # never the code/body
    return ok, parsed_body


def start():
    """Start the OAuth bridge in the brain (`shimpz-login run`, detached)."""
    return _call("POST", "/v1/brain/login/start")


def url():
    """Poll for the authorize URL the bridge wrote ({"url": ...} or {"pending": true})."""
    return _call("GET", "/v1/brain/login/url")


def code(value):
    """Forward the pasted OAuth code to `shimpz-login submit` (validated + argv-exec'd driver-side)."""
    return _call("POST", "/v1/brain/login/code", {"code": value})


def status():
    """Read the brain's Claude auth status ({"loggedIn": bool, "email": str|null})."""
    return _call("GET", "/v1/brain/login/status")
