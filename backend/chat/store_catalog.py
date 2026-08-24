"""Bounded Local chat discovery from the fixed public Store catalog."""

from __future__ import annotations

import contextlib
import http.client
import json
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

CATALOG_HOST = "shimpz.com"
CATALOG_PATH = "/api/assistants"
CATALOG_TIMEOUT_SECONDS = 5
CATALOG_TTL_SECONDS = 60
MAX_CATALOG_BYTES = 512 * 1024
MAX_ASSISTANTS = 256
_ASSISTANT_ID = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_CREATOR = re.compile(r"^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_GITHUB = re.compile(
    r"^https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$"
)
_HUMAN_REQUEST_KINDS = frozenset(
    {
        "approval",
        "input:text",
        "input:textarea",
        "input:password",
        "input:phone",
        "input:select",
        "input:choice",
        "input:choices",
        "auth:password",
        "auth:totp",
        "auth:passkey",
    }
)
_ASSISTANT_FIELDS = frozenset(
    {
        "assistant_id",
        "name",
        "summary",
        "assistant_version",
        "creators",
        "github",
        "icon_digest",
        "source_digest",
        "platforms",
        "allowed_hosts",
        "integrations",
        "actions",
    }
)


class CatalogUnavailableError(OSError):
    """The optional public discovery catalog could not be admitted."""


@dataclass(frozen=True, slots=True)
class CatalogIntegration:
    provider: str
    scopes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CatalogAssistant:
    assistant_id: str
    name: str
    summary: str
    source_digest: str
    integrations: tuple[CatalogIntegration, ...]
    actions: tuple[str, ...]


def _text(value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value.strip() != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("catalog text is invalid")
    return value


def _strings(value: object, maximum: int, item_maximum: int) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("catalog string collection is invalid")
    output = tuple(_text(item, item_maximum) for item in value)
    if len(set(output)) != len(output):
        raise ValueError("catalog string collection is invalid")
    return output


def _integrations(value: object) -> tuple[CatalogIntegration, ...]:
    if not isinstance(value, list) or len(value) > 16:
        raise ValueError("catalog Integrations are invalid")
    output: list[CatalogIntegration] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"id", "provider", "scopes"}:
            raise ValueError("catalog Integration is invalid")
        integration_id = item["id"]
        provider = item["provider"]
        if (
            not isinstance(integration_id, str)
            or integration_id != provider
            or _ASSISTANT_ID.fullmatch(integration_id) is None
        ):
            raise ValueError("catalog Integration identity is invalid")
        output.append(CatalogIntegration(provider=provider, scopes=_strings(item["scopes"], 32, 128)))
    if len({item.provider for item in output}) != len(output):
        raise ValueError("catalog Integrations are duplicated")
    return tuple(output)


def _actions(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 64:
        raise ValueError("catalog Actions are invalid")
    output: list[str] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"id", "integrations", "human_requests"}:
            raise ValueError("catalog Action is invalid")
        action_id = item["id"]
        integrations = _strings(item["integrations"], 16, 64)
        requests = _strings(item["human_requests"], 11, 25)
        if (
            not isinstance(action_id, str)
            or _ASSISTANT_ID.fullmatch(action_id) is None
            or any(_ASSISTANT_ID.fullmatch(integration) is None for integration in integrations)
            or any(request not in _HUMAN_REQUEST_KINDS for request in requests)
        ):
            raise ValueError("catalog Action is invalid")
        output.append(action_id)
    if len(set(output)) != len(output):
        raise ValueError("catalog Actions are duplicated")
    return tuple(output)


def _assistant(value: object) -> CatalogAssistant:
    if not isinstance(value, dict) or set(value) != _ASSISTANT_FIELDS:
        raise ValueError("catalog Assistant fields are invalid")
    assistant_id = value["assistant_id"]
    if not isinstance(assistant_id, str) or _ASSISTANT_ID.fullmatch(assistant_id) is None:
        raise ValueError("catalog Assistant identifier is invalid")
    if not isinstance(value["assistant_version"], str) or _VERSION.fullmatch(value["assistant_version"]) is None:
        raise ValueError("catalog Assistant version is invalid")
    if not isinstance(value["source_digest"], str) or _DIGEST.fullmatch(value["source_digest"]) is None:
        raise ValueError("catalog source digest is invalid")
    if not isinstance(value["icon_digest"], str) or _DIGEST.fullmatch(value["icon_digest"]) is None:
        raise ValueError("catalog icon digest is invalid")
    if value["platforms"] != ["linux/amd64", "linux/arm64"]:
        raise ValueError("catalog platforms are invalid")
    if not isinstance(value["github"], str) or _GITHUB.fullmatch(value["github"]) is None:
        raise ValueError("catalog repository is invalid")
    creators = _strings(value["creators"], 16, 39)
    if not creators or any(_CREATOR.fullmatch(creator) is None for creator in creators):
        raise ValueError("catalog Creators are invalid")
    allowed_hosts = _strings(value["allowed_hosts"], 32, 253)
    if any(host != host.lower() or "/" in host or ":" in host for host in allowed_hosts):
        raise ValueError("catalog allowed hosts are invalid")
    return CatalogAssistant(
        assistant_id=assistant_id,
        name=_text(value["name"], 80),
        summary=_text(value["summary"], 160),
        source_digest=value["source_digest"],
        integrations=_integrations(value["integrations"]),
        actions=_actions(value["actions"]),
    )


def validate_catalog(value: object) -> tuple[CatalogAssistant, ...]:
    """Return the exact bounded Store projection or reject the whole snapshot."""
    if not isinstance(value, dict) or set(value) != {"version", "assistants"} or value["version"] != 1:
        raise ValueError("catalog envelope is invalid")
    raw = value["assistants"]
    if not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("catalog size is invalid")
    assistants = tuple(_assistant(item) for item in raw)
    identities = [item.assistant_id for item in assistants]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise ValueError("catalog Assistant ordering is invalid")
    return assistants


def _content_length(response: http.client.HTTPResponse) -> None:
    value = response.getheader("Content-Length")
    if value is None:
        return
    try:
        length = int(value)
    except ValueError as exc:
        raise CatalogUnavailableError("invalid Store catalog length") from exc
    if not 1 <= length <= MAX_CATALOG_BYTES:
        raise CatalogUnavailableError("invalid Store catalog length")


def fetch_catalog(
    connection_factory: Callable[..., http.client.HTTPSConnection] = http.client.HTTPSConnection,
) -> tuple[CatalogAssistant, ...]:
    """Fetch one host-pinned Store snapshot without redirects or stale fallback."""
    connection = None
    try:
        connection = connection_factory(CATALOG_HOST, 443, timeout=CATALOG_TIMEOUT_SECONDS)
        connection.request("GET", CATALOG_PATH, headers={"Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise CatalogUnavailableError("Store catalog is unavailable")
        content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
        if content_type != "application/json":
            raise CatalogUnavailableError("invalid Store catalog content type")
        _content_length(response)
        raw = response.read(MAX_CATALOG_BYTES + 1)
        if not raw or len(raw) > MAX_CATALOG_BYTES:
            raise CatalogUnavailableError("invalid Store catalog length")
        return validate_catalog(json.loads(raw))
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeError, TypeError, ValueError) as exc:
        if isinstance(exc, CatalogUnavailableError):
            raise
        raise CatalogUnavailableError("Store catalog is unavailable") from exc
    finally:
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()


class StoreCatalog:
    """Serialize optional discovery refreshes and retain only a short valid snapshot."""

    def __init__(
        self,
        *,
        loader: Callable[[], tuple[CatalogAssistant, ...]] = fetch_catalog,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._clock = clock
        self._lock = threading.Lock()
        self._expires_at = 0.0
        self._assistants: tuple[CatalogAssistant, ...] = ()
        self._failed = False

    def get(self) -> tuple[CatalogAssistant, ...]:
        with self._lock:
            now = self._clock()
            if self._expires_at > now:
                if self._failed:
                    raise CatalogUnavailableError("Store catalog is unavailable")
                return self._assistants
        try:
            assistants = self._loader()
        except CatalogUnavailableError:
            with self._lock:
                now = self._clock()
                if self._expires_at > now and not self._failed:
                    return self._assistants
                self._assistants = ()
                self._failed = True
                self._expires_at = now + CATALOG_TTL_SECONDS
            raise
        with self._lock:
            self._assistants = assistants
            self._failed = False
            self._expires_at = self._clock() + CATALOG_TTL_SECONDS
            return assistants
