"""Per-credential validation — LIVE remote checks where one cheap call exists, regex otherwise.

Fail-fast at config time: each check returns (ok, detail) and distinguishes "credential rejected"
from "network unreachable" in the detail, never logging or echoing the value itself.

IPv4-first: dual-stack endpoints (api.cloudflare.com, api.openai.com, …) fail TLS handshake on
hosts with broken IPv6 egress (this repo's own incident class — see MEMORY.md gotchas; the
container bakes a gai.conf fix, but the wizard runs on the BARE host of a fresh machine where no
such fix exists). Sorting A records first is the fail-safe.
"""

import json
import re
import socket
import urllib.error
import urllib.request

import keyset

TIMEOUT_S = 10

_real_getaddrinfo = socket.getaddrinfo


def _ipv4_first(*args, **kwargs):
    res = _real_getaddrinfo(*args, **kwargs)
    return sorted(res, key=lambda ai: ai[0] != socket.AF_INET)


socket.getaddrinfo = _ipv4_first


def _http_json(url, headers):
    """GET `url` → (status, parsed-json-or-None). Network failure raises URLError/TimeoutError."""
    req = urllib.request.Request(url, headers={"User-Agent": "shimpz-admin-wizard", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", errors="replace") or "null")
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a status we branch on
        return e.code, None


def _live_openai(value):
    status, _ = _http_json("https://api.openai.com/v1/models", {"Authorization": f"Bearer {value}"})
    if status == 200:
        return True, "key accepted"
    return False, f"OpenAI rejected the key (HTTP {status})"


def _live_github(value):
    status, body = _http_json("https://api.github.com/user", {"Authorization": f"Bearer {value}"})
    if status == 200 and body:
        return True, f"user {body.get('login', '?')}"
    return False, f"GitHub rejected the token (HTTP {status})"


_LIVE = {
    "live_openai": _live_openai,
    "live_github": _live_github,
}


def validate(key, value):
    """(ok, detail) for one field. Unknown key raises; empty value is only OK when optional."""
    f = keyset.field(key)
    value = value.strip()
    if not value:
        return (not f["required"], "required" if f["required"] else "empty (optional)")
    kind = f["validator"]
    if kind is None:
        return True, "accepted (no validator)"
    if kind.startswith("re:"):
        if re.fullmatch(kind[3:], value):
            return True, "format OK"
        return False, f"does not match expected format ({kind[3:]})"
    try:
        return _LIVE[kind](value)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return False, f"network error reaching the validation endpoint: {e}"
