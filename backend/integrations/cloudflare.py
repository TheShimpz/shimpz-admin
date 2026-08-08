"""Closed Cloudflare OAuth scope projection shared by Admin boundaries."""

from __future__ import annotations

import re

ALLOWED_SCOPES = frozenset({"dns.read", "dns.write", "offline_access", "zone.read"})

_SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def canonical_authorization_scopes(value: object) -> tuple[str, ...]:
    if not isinstance(value, str):
        raise ValueError("invalid OAuth scopes")
    scopes = tuple(value.split(" "))
    if (
        len(scopes) > len(ALLOWED_SCOPES)
        or any(_SCOPE_RE.fullmatch(scope) is None for scope in scopes)
        or len(set(scopes)) != len(scopes)
        or scopes != tuple(sorted(scopes))
        or not set(scopes) <= ALLOWED_SCOPES
    ):
        raise ValueError("invalid OAuth scopes")
    return scopes
