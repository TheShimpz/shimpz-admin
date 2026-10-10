"""Browser response policy for the compiled Admin SPA and its same-origin API."""

import base64
import hashlib
from collections.abc import Callable
from html.parser import HTMLParser
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse

from protocol.http.v1.websocket import canonical_origin

PERMISSIONS_POLICY = "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class _InlineScriptCollector(HTMLParser):
    """Collect only SvelteKit's generated inline bootstrap scripts."""

    def __init__(self) -> None:
        super().__init__()
        self._collecting = False
        self._chunks: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._collecting = tag == "script" and "src" not in dict(attrs)
        if self._collecting:
            self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._collecting:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._collecting:
            self.scripts.append("".join(self._chunks))
            self._collecting = False


def spa_script_sources(ui_dir: Path) -> tuple[str, ...]:
    """Hash the compiled SPA's inline bootstrap scripts once, so the policy can admit exactly them."""
    index = ui_dir / "index.html"
    if not index.is_file():
        return ()
    collector = _InlineScriptCollector()
    collector.feed(index.read_text(encoding="utf-8"))
    return tuple(
        "'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'"
        for script in collector.scripts
    )


def _socket_source(origin: str) -> str:
    if origin.startswith("https://"):
        return "wss" + origin.removeprefix("https")
    return "ws" + origin.removeprefix("http")


def security_headers(script_sources: tuple[str, ...], admitted_origins: frozenset[str]) -> dict[str, str]:
    """Build one fail-closed policy bound to the exact compiled SPA bootstrap and Admin's admitted chat origins.

    A WebSocket may reach only an admitted Admin origin, never another host.
    """
    script_policy = " ".join(("'self'", *script_sources))
    socket_policy = " ".join(("'self'", *sorted(_socket_source(origin) for origin in admitted_origins)))
    content_security_policy = "; ".join(
        (
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "frame-src 'none'",
            "form-action 'self'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            f"script-src {script_policy}",
            # Svelte uses inline style attributes for runtime frame sizing. Scripts remain hash-bound.
            "style-src 'self' 'unsafe-inline'",
            f"connect-src {socket_policy}",
        )
    )
    return {
        "Content-Security-Policy": content_security_policy,
        "Permissions-Policy": PERMISSIONS_POLICY,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }


def admits_unsafe_request(request: Request, admitted_origins: Callable[[], frozenset[str]]) -> bool:
    """Admit a state-changing request only from Admin's own page at an origin Admin admits (CSRF).

    SameSite is site-scoped, so another loopback port or a sibling host still sends the session cookie. Fetch
    Metadata must say `same-origin` and an Origin must be one exact admitted origin; whichever header the client
    sends must pass, and a request carrying neither is refused.
    """
    if request.method not in UNSAFE_METHODS:
        return True
    fetch_sites = request.headers.getlist("sec-fetch-site")
    origins = request.headers.getlist("origin")
    if len(fetch_sites) > 1 or len(origins) > 1 or not (fetch_sites or origins):
        return False
    if fetch_sites and fetch_sites[0] != "same-origin":
        return False
    if origins:
        origin = canonical_origin(origins[0])
        return origin == origins[0] and origin in admitted_origins()
    return True


def oauth_completion_mode(request: Request, select_mode: Callable[[Request], str]) -> str | None:
    """Project Admin's request-origin decision before the browser needs popup activation."""
    try:
        callback_mode = select_mode(request)
    except HTTPException as exc:
        if exc.status_code == 409:
            return None
        raise
    return "code" if callback_mode == "out-of-band" else "automatic"


def oauth_chat_redirect(
    failure: str = "",
    *,
    cookie_name: str,
    cookie_path: str,
) -> RedirectResponse:
    """Return to the token-free Chat URL after discarding the OAuth browser binding."""
    if failure not in {"", "start-failed", "callback-failed"}:
        raise RuntimeError("invalid OAuth redirect failure")
    location = "/chat" if not failure else f"/chat?oauth={failure}"
    response = RedirectResponse(location, status_code=303)
    response.delete_cookie(cookie_name, path=cookie_path)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response
