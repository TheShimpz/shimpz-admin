"""Capsule provisioning client — the panel's authenticated bridge to capsule-driver.

The panel holds no docker.sock; capsule-driver holds the socket but no session/UI. The owner's signed
session gates these calls (the FastAPI middleware), and capsule-driver's bearer token authorizes the ONE
internal hop over capsuledriver_net. NEVER raises — a driver hiccup is reported (ok=False) for the UI,
not fatal. Mirrors integrations.recreate exactly.
"""

import http.client
import json
import logging
import os
import re
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_CAPSULEDRIVER_URL", "http://capsule-driver:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_CAPSULEDRIVER_TOKEN_FILE", "/run/shimpz-capsuledriver/token")


def to_cid(name):
    """A capsule NAME → the Docker/Postgres-safe id (matches capsule-driver's own validate.sanitize)."""
    return re.sub(r"[^a-z0-9_]+", "_", str(name).lower()).strip("_")[:40]


def _call(method, path, payload=None):
    parsed = urlparse(URL)
    try:
        token = Path(TOKEN_FILE).read_text(encoding="utf-8").strip()
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 7077, timeout=180)
        body = json.dumps(payload) if payload is not None else None
        headers = {"Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body, headers)
        resp = conn.getresponse()
        data = json.loads(resp.read() or b"{}")
        conn.close()
    except (OSError, json.JSONDecodeError) as e:
        log.warning("capsule %s %s failed to reach the driver: %s", method, path, e)
        return False, {"error": f"could not reach capsule-driver: {e}"}
    ok = 200 <= resp.status < 300
    log.info("capsule %s %s -> HTTP %s ok=%s", method, path, resp.status, ok)
    return ok, data


def list_capsules():
    return _call("GET", "/v1/capsules")


def create(cid, name):
    return _call("POST", f"/v1/capsules/{cid}/create", {"name": name})


def destroy(cid):
    return _call("DELETE", f"/v1/capsules/{cid}")
