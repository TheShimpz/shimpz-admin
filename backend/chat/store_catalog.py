"""Bounded Local discovery from the fixed public Store catalog, fetched and cached per interface language.

Only each summary is localized, from the publication's own pack (ADR-0091); everything else is canonical, so chat
planning reads the canonical English catalog while the Assistants page reads the Supervisor's interface language.
"""

from __future__ import annotations

import contextlib
import hashlib
import http.client
import json
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from protocol.http.v1 import payload as team_contract

CATALOG_HOST = "shimpz.com"
CATALOG_PATH = "/api/assistants"
# Chat planning and icon resolution use the canonical English catalog; summaries are its only localized field.
PLANNING_LOCALE = "en"
CATALOG_TIMEOUT_SECONDS = 5
CATALOG_TTL_SECONDS = 60
# The producer contract: Store and Developers admit up to 1,000 Assistants and Store reads at most 4 MiB of them.
MAX_CATALOG_BYTES = 4 * 1024 * 1024
MAX_ICON_BYTES = 1024 * 1024
MAX_ASSISTANTS = 1000
# The producer contract: Developers' install protocol admits up to 128 Actions per Assistant.
MAX_ACTIONS = 128
# Icons stay a bounded process-memory cache, independent of the catalog size.
MAX_CACHED_ICONS = 256
# Catalogs above this admitted byte budget intentionally retain only their most-recently-used subset.
MAX_CACHED_ICON_BYTES = 8 * 1024 * 1024
VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
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


class CatalogAssistantNotFoundError(LookupError):
    """The requested Assistant is not present in the current public catalog."""


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
    icon_digest: str
    integrations: tuple[CatalogIntegration, ...]
    actions: tuple[str, ...]
    assistant_version: str = ""
    creators: tuple[str, ...] = ()


def catalog_text(value: object, maximum: int) -> str:
    """One bounded, trimmed, control-free line of Assistant display text from a catalog."""
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
    output = tuple(catalog_text(item, item_maximum) for item in value)
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
        if team_contract.canonical_identifier(integration_id) is None or integration_id != provider:
            raise ValueError("catalog Integration identity is invalid")
        output.append(CatalogIntegration(provider=provider, scopes=_strings(item["scopes"], 32, 128)))
    if len({item.provider for item in output}) != len(output):
        raise ValueError("catalog Integrations are duplicated")
    return tuple(output)


def _actions(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ACTIONS:
        raise ValueError("catalog Actions are invalid")
    output: list[str] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"id", "integrations", "human_requests"}:
            raise ValueError("catalog Action is invalid")
        action_id = item["id"]
        integrations = _strings(item["integrations"], 16, 64)
        requests = _strings(item["human_requests"], 11, 25)
        if (
            team_contract.canonical_identifier(action_id) is None
            or any(team_contract.canonical_identifier(integration) is None for integration in integrations)
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
    if team_contract.canonical_assistant_id(assistant_id) is None:
        raise ValueError("catalog Assistant identifier is invalid")
    if not isinstance(value["assistant_version"], str) or VERSION_RE.fullmatch(value["assistant_version"]) is None:
        raise ValueError("catalog Assistant version is invalid")
    if (
        not isinstance(value["source_digest"], str)
        or team_contract.SOURCE_DIGEST_RE.fullmatch(value["source_digest"]) is None
    ):
        raise ValueError("catalog source digest is invalid")
    if (
        not isinstance(value["icon_digest"], str)
        or team_contract.SOURCE_DIGEST_RE.fullmatch(value["icon_digest"]) is None
    ):
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
        name=catalog_text(value["name"], 80),
        summary=catalog_text(value["summary"], 160),
        source_digest=value["source_digest"],
        icon_digest=value["icon_digest"],
        integrations=_integrations(value["integrations"]),
        actions=_actions(value["actions"]),
        assistant_version=value["assistant_version"],
        creators=creators,
    )


def validate_catalog(value: object, locale: str) -> tuple[CatalogAssistant, ...]:
    """Return the exact bounded Store projection in exactly the requested locale or reject the whole snapshot."""
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "locale", "assistants"}
        or value["version"] != 1
        or team_contract.canonical_locale(locale) is None
        or value["locale"] != locale
    ):
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
    locale: str,
    connection_factory: Callable[..., http.client.HTTPSConnection] = http.client.HTTPSConnection,
) -> tuple[CatalogAssistant, ...]:
    """Fetch one host-pinned Store snapshot in one interface language without redirects or stale fallback."""
    if team_contract.canonical_locale(locale) is None:
        raise CatalogUnavailableError("Store catalog locale is invalid")
    connection = None
    try:
        connection = connection_factory(CATALOG_HOST, 443, timeout=CATALOG_TIMEOUT_SECONDS)
        connection.request("GET", f"{CATALOG_PATH}?locale={locale}", headers={"Accept": "application/json"})
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
        return validate_catalog(json.loads(raw), locale)
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeError, TypeError, ValueError) as exc:
        if isinstance(exc, CatalogUnavailableError):
            raise
        raise CatalogUnavailableError("Store catalog is unavailable") from exc
    finally:
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()


@dataclass(slots=True)
class _CatalogEntry:
    expires_at: float = 0.0
    assistants: tuple[CatalogAssistant, ...] = ()
    failed: bool = False


class StoreCatalog:
    """Serialize optional discovery refreshes and retain only a short valid snapshot per interface language."""

    def __init__(
        self,
        *,
        loader: Callable[[str], tuple[CatalogAssistant, ...]] = fetch_catalog,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._loader = loader
        self._clock = clock
        self._lock = threading.Lock()
        # One refresh at a time: a reader that waited behind a refresh reuses its result instead of loading again.
        self._refresh = threading.Lock()
        # Keyed by the closed locale set, so at most one bounded snapshot per interface language.
        self._entries: dict[str, _CatalogEntry] = {}

    def _cached(self, locale: str) -> tuple[CatalogAssistant, ...] | None:
        with self._lock:
            entry = self._entries.get(locale)
            if entry is None or entry.expires_at <= self._clock():
                return None
            if entry.failed:
                raise CatalogUnavailableError("Store catalog is unavailable")
            return entry.assistants

    def get(self, locale: str) -> tuple[CatalogAssistant, ...]:
        if team_contract.canonical_locale(locale) is None:
            raise CatalogUnavailableError("Store catalog locale is invalid")
        cached = self._cached(locale)
        if cached is not None:
            return cached
        with self._refresh:
            cached = self._cached(locale)
            if cached is not None:
                return cached
            try:
                assistants = self._loader(locale)
            except CatalogUnavailableError:
                with self._lock:
                    self._entries[locale] = _CatalogEntry(self._clock() + CATALOG_TTL_SECONDS, (), True)
                raise
            with self._lock:
                self._entries[locale] = _CatalogEntry(self._clock() + CATALOG_TTL_SECONDS, assistants, False)
                return assistants


class StoreIconCache:
    """Bound immutable, digest-verified Store icon bytes in process memory."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._icons: OrderedDict[tuple[str, str], bytes] = OrderedDict()
        self._cached_bytes = 0

    def get(self, key: tuple[str, str]) -> bytes | None:
        with self._lock:
            contents = self._icons.get(key)
            if contents is not None:
                self._icons.move_to_end(key)
            return contents

    def remember(self, key: tuple[str, str], contents: bytes) -> None:
        with self._lock:
            self._cached_bytes -= len(self._icons.pop(key, b""))
            self._icons[key] = contents
            self._cached_bytes += len(contents)
            while len(self._icons) > MAX_CACHED_ICONS or self._cached_bytes > MAX_CACHED_ICON_BYTES:
                _, evicted = self._icons.popitem(last=False)
                self._cached_bytes -= len(evicted)


CATALOG = StoreCatalog()
ICON_CACHE = StoreIconCache()


def _icon_content_length(response: http.client.HTTPResponse) -> int:
    value = response.getheader("Content-Length")
    if value is None or not value.isascii() or not value.isdigit():
        raise CatalogUnavailableError("invalid Store icon length")
    length = int(value)
    if not 1 <= length <= MAX_ICON_BYTES:
        raise CatalogUnavailableError("invalid Store icon length")
    return length


def fetch_assistant_icon(
    assistant_id: str,
    *,
    catalog: StoreCatalog | None = None,
    cache: StoreIconCache | None = None,
    connection_factory: Callable[..., http.client.HTTPSConnection] = http.client.HTTPSConnection,
) -> bytes:
    """Fetch one current public Assistant icon without accepting browser-supplied digests."""
    if team_contract.canonical_assistant_id(assistant_id) is None:
        raise CatalogAssistantNotFoundError("Assistant is not in the public catalog")
    assistants = (CATALOG if catalog is None else catalog).get(PLANNING_LOCALE)
    assistant = next((item for item in assistants if item.assistant_id == assistant_id), None)
    if assistant is None:
        raise CatalogAssistantNotFoundError("Assistant is not in the public catalog")
    icon_cache = ICON_CACHE if cache is None else cache
    cache_key = (assistant.source_digest, assistant.icon_digest)
    cached = icon_cache.get(cache_key)
    if cached is not None:
        return cached
    source_hash = assistant.source_digest.removeprefix("sha256:")
    icon_hash = assistant.icon_digest.removeprefix("sha256:")
    path = f"/api/assistant-icons/{source_hash}/{icon_hash}.png"
    connection = None
    try:
        connection = connection_factory(CATALOG_HOST, 443, timeout=CATALOG_TIMEOUT_SECONDS)
        connection.request("GET", path, headers={"Accept": "image/png"})
        response = connection.getresponse()
        if response.status != 200:
            raise CatalogUnavailableError("Store icon is unavailable")
        content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
        if content_type != "image/png":
            raise CatalogUnavailableError("invalid Store icon content type")
        length = _icon_content_length(response)
        contents = response.read(MAX_ICON_BYTES + 1)
        if len(contents) != length or hashlib.sha256(contents).hexdigest() != icon_hash:
            raise CatalogUnavailableError("invalid Store icon")
    except (OSError, http.client.HTTPException) as exc:
        if isinstance(exc, CatalogUnavailableError):
            raise
        raise CatalogUnavailableError("Store icon is unavailable") from exc
    else:
        icon_cache.remember(cache_key, contents)
        return contents
    finally:
        if connection is not None:
            with contextlib.suppress(OSError):
                connection.close()
