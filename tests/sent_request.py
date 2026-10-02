"""The browser's name for one logical chat send (ADR-0092): a fresh nonce, unless a test resends one."""

from __future__ import annotations

import secrets


def sent_request(nonce: str | None = None, *, resend: bool = False) -> dict[str, object]:
    return {"nonce": nonce or secrets.token_hex(16), "resend": resend}
