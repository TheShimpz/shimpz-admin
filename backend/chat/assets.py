"""Bounded same-origin projection of public Assistant icons used by chat."""

from __future__ import annotations

import asyncio

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import HTTPException
from fastapi.responses import Response

from chat import store_catalog

_ICON_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-icon",
)


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
