"""The public Store catalog in bounded pages for the session socket, and the same-origin public Assistant icons."""

import asyncio
import hashlib
import json
import re

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import HTTPException
from fastapi.responses import Response
from protocol.socket.v1 import frames

from chat import store_catalog
from protocol.http.v1 import payload as team_contract

_ICON_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-icon",
)
CATALOG_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=1,
    max_outstanding=1,
    thread_name_prefix="shimpz-admin-catalog",
)


# One page's Assistants take at most this many bytes, so the whole result frame, its envelope included (a 64-character
# call id, the status, the version, the locale, and the next cursor), fits the session socket's outbound bound.
PAGE_BYTES = frames.MAX_OUTBOUND_BYTES - 4 * 1024
# The next page: the offset of its first Assistant and the digest of the catalog the earlier pages came from.
CURSOR_RE = re.compile(r"([1-9][0-9]{0,3})\.([0-9a-f]{32})\Z")
CATALOG_FULL = (503, {"detail": "Assistant catalog is unavailable"})


def _catalog(locale: str) -> tuple[str, list[dict[str, object]], list[int]]:
    """The catalog in one interface language: its digest, its entries, and each entry's serialized size."""
    try:
        assistants = store_catalog.CATALOG.get(locale)
    except store_catalog.CatalogUnavailableError:
        raise HTTPException(status_code=502, detail="Assistant catalog is unavailable") from None
    entries = [_catalog_entry(assistant) for assistant in assistants]
    encoded = [json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode() for entry in entries]
    return hashlib.sha256(b"\n".join(encoded)).hexdigest()[:32], entries, [len(item) for item in encoded]


class _CatalogChangedError(Exception):
    """The catalog the earlier pages came from is no longer the current one."""


def _start(cursor: str | None, digest: str, count: int) -> int:
    if cursor is None:
        return 0
    match = CURSOR_RE.fullmatch(cursor)
    if match is None:
        raise HTTPException(status_code=400, detail="Assistant catalog cursor is invalid")
    if match[2] != digest:
        raise _CatalogChangedError
    if int(match[1]) >= count:
        raise HTTPException(status_code=400, detail="Assistant catalog cursor is invalid")
    return int(match[1])


def catalog_page(locale: str, cursor: str | None = None) -> dict[str, object] | tuple[int, dict[str, str]]:
    """One bounded page of the Store projection the Assistants pages show, in one interface language.

    The first page has no cursor; each page names the next one until the last, which names none. A catalog that
    changed between pages is refused (409), so the pages a client joins always come from one catalog.
    """
    canonical = team_contract.canonical_locale(locale)
    if canonical is None:
        raise HTTPException(status_code=422, detail="Assistant catalog locale is invalid")
    digest, entries, sizes = _catalog(canonical)
    try:
        start = _start(cursor, digest, len(entries))
    except _CatalogChangedError:
        return 409, {"code": "catalog-changed", "detail": "The Assistant catalog changed; read it again"}
    end, used = start, 0
    while end < len(entries) and used + sizes[end] + 1 <= PAGE_BYTES:
        used += sizes[end] + 1
        end += 1
    if end == start < len(entries):
        raise HTTPException(status_code=502, detail="Assistant catalog is unavailable")
    return {
        "version": 1,
        "locale": canonical,
        "assistants": entries[start:end],
        "next": f"{end}.{digest}" if end < len(entries) else None,
    }


def _catalog_entry(assistant: store_catalog.CatalogAssistant) -> dict[str, object]:
    """One publication as the Assistants page lists it and shows it on its own page."""
    page = assistant.page
    if page is None:
        raise HTTPException(status_code=502, detail="Assistant catalog is unavailable")
    return {
        "assistant_id": assistant.assistant_id,
        "name": assistant.name,
        "summary": assistant.summary,
        "description": page.description,
        "assistant_version": assistant.assistant_version,
        "creators": list(assistant.creators),
        "links": dict(page.links),
        "source_digest": assistant.source_digest,
        "icon_digest": assistant.icon_digest,
        "actions": [
            {"id": action.id, "effect": action.effect, "description": action.description} for action in page.actions
        ],
        "integrations": [{"id": provider, "provider": provider} for provider in assistant.integrations],
        "stored_inputs": [
            {"id": item.id, "label": item.label, "description": item.description, "help_url": item.help_url}
            for item in page.stored_inputs
        ],
    }


async def assistant_icon(assistant_id: str) -> Response:
    """Return one catalog-resolved PNG without making the browser an asset authority."""
    try:
        future = submit_in_context(_ICON_EXECUTOR, store_catalog.fetch_assistant_icon, assistant_id)
    except ExecutorSaturatedError:
        raise HTTPException(status_code=503, detail="Assistant icon is unavailable") from None
    try:
        contents = await asyncio.wrap_future(future)
    except store_catalog.CatalogAssistantNotFoundError:
        raise HTTPException(status_code=404, detail="Assistant icon is unavailable") from None
    except store_catalog.CatalogUnavailableError:
        raise HTTPException(status_code=502, detail="Assistant icon is unavailable") from None
    return Response(
        content=contents,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
