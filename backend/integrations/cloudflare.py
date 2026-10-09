"""Closed Cloudflare OAuth scope and start-URL projection shared by Admin boundaries."""

import re
from urllib.parse import parse_qsl, urlsplit

ALLOWED_SCOPES = frozenset({"dns.read", "dns.write", "offline_access", "zone.read"})

SCOPE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_PKCE_VALUE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


def canonical_authorization_scopes(value: object) -> tuple[str, ...]:
    if not isinstance(value, str):
        raise ValueError("invalid OAuth scopes")
    scopes = tuple(value.split(" "))
    if (
        len(scopes) > len(ALLOWED_SCOPES)
        or any(SCOPE_RE.fullmatch(scope) is None for scope in scopes)
        or len(set(scopes)) != len(scopes)
        or scopes != tuple(sorted(scopes))
        or not set(scopes) <= ALLOWED_SCOPES
    ):
        raise ValueError("invalid OAuth scopes")
    return scopes


def authorization_state(value: object, callback_mode: str) -> str:
    """Return the state of one exact, unnormalized Shimpz Cloudflare start URL, or raise ValueError."""
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or any(not 0x21 <= ord(c) <= 0x7E for c in value):
        raise ValueError("invalid OAuth authorization URL")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)
    except ValueError as exc:
        raise ValueError("invalid OAuth authorization URL") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "shimpz.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/api/oauth/cloudflare/start"
        or parsed.fragment
        or len(query) != 4
        or len({key for key, _value in query}) != 4
    ):
        raise ValueError("invalid OAuth authorization URL")
    fields = dict(query)
    if (
        set(fields) != {"state", "code_challenge", "scope", "callback"}
        or _PKCE_VALUE_RE.fullmatch(fields["state"]) is None
        or _PKCE_VALUE_RE.fullmatch(fields["code_challenge"]) is None
        or fields["callback"] != callback_mode
    ):
        raise ValueError("invalid OAuth authorization URL")
    canonical_authorization_scopes(fields["scope"])
    return fields["state"]
