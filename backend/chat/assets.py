"""Bounded same-origin projection of public Assistant icons used by chat."""

import asyncio

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response

from chat import store_catalog
from protocol.http.v1 import payload as team_contract

_ICON_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-icon",
)
_CATALOG_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=1,
    max_outstanding=1,
    thread_name_prefix="shimpz-admin-catalog",
)


async def assistant_catalog(locale: str = "") -> JSONResponse:
    """Return the bounded Store projection needed by the authenticated Admin catalog in one interface language."""
    canonical = team_contract.canonical_locale(locale)
    if canonical is None:
        raise HTTPException(status_code=422, detail="Assistant catalog locale is invalid")
    try:
        future = submit_in_context(_CATALOG_EXECUTOR, store_catalog.CATALOG.get, canonical)
    except ExecutorSaturatedError:
        raise HTTPException(status_code=503, detail="Assistant catalog is unavailable") from None
    try:
        assistants = await asyncio.wrap_future(future)
    except store_catalog.CatalogUnavailableError:
        raise HTTPException(status_code=502, detail="Assistant catalog is unavailable") from None
    return JSONResponse(
        content={
            "version": 1,
            "locale": canonical,
            "assistants": [_catalog_entry(assistant) for assistant in assistants],
        },
        headers={"Cache-Control": "no-store"},
    )


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
        "integrations": [{"id": item.provider, "provider": item.provider} for item in assistant.integrations],
        "stored_inputs": [{"id": identifier, "label": label} for identifier, label in page.stored_inputs],
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
