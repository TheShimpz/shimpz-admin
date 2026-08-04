"""Browser response policy for the compiled Admin SPA and its same-origin API."""

from __future__ import annotations

import base64
import hashlib
from html.parser import HTMLParser
from pathlib import Path

PERMISSIONS_POLICY = "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()"


class _InlineScriptCollector(HTMLParser):
    """Collect only SvelteKit's generated inline bootstrap scripts."""

    def __init__(self) -> None:
        super().__init__()
        self._collecting = False
        self._chunks: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._collecting = tag == "script" and not any(name == "src" for name, _value in attrs)
        if self._collecting:
            self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._collecting:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._collecting:
            self.scripts.append("".join(self._chunks))
            self._collecting = False


def _spa_script_sources(ui_dir: Path) -> tuple[str, ...]:
    index = ui_dir / "index.html"
    if not index.is_file():
        return ()
    collector = _InlineScriptCollector()
    collector.feed(index.read_text(encoding="utf-8"))
    return tuple(
        "'sha256-"
        + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        + "'"
        for script in collector.scripts
    )


def security_headers(ui_dir: Path) -> dict[str, str]:
    """Build one fail-closed policy bound to the exact compiled SPA bootstrap."""
    script_policy = " ".join(("'self'", *_spa_script_sources(ui_dir)))
    content_security_policy = "; ".join(
        (
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "frame-src https://shimpz.com",
            "form-action 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            f"script-src {script_policy}",
            # Svelte uses inline style attributes for runtime frame sizing. Scripts remain hash-bound.
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'self' ws: wss:",
        )
    )
    return {
        "Content-Security-Policy": content_security_policy,
        "Permissions-Policy": PERMISSIONS_POLICY,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }
