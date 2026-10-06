"""Bounded same-origin HTTP adaptation for Team controller responses."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from team import bridge

from protocol.http.v1 import websocket as chat_ws_common


@contextmanager
def refused_as_bad_request() -> Iterator[None]:
    """Answer a request Admin refused before any Team call as the browser's own 400, with the refusal's reason."""
    try:
        yield
    except bridge.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


def response(action) -> JSONResponse:
    with refused_as_bad_request():
        result = action()
    return JSONResponse(status_code=result.status, content=result.body)


async def bounded_json_object(
    request: Request,
    max_bytes: int = bridge.MAX_JSON_BODY_BYTES,
) -> dict:
    """Read one JSON object without allowing a request to grow without bound."""
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="content type must be application/json")
    raw_length = request.headers.get("content-length")
    if raw_length is not None:
        if not raw_length.isascii() or not raw_length.isdigit():
            raise HTTPException(status_code=400, detail="invalid content length")
        if int(raw_length) > max_bytes:
            raise HTTPException(status_code=413, detail="request body too large")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise HTTPException(status_code=413, detail="request body too large")
    try:
        payload = json.loads(
            body,
            object_pairs_hook=chat_ws_common.unique_json_object,
            parse_constant=chat_ws_common._reject_json_constant,
        )
    except json.JSONDecodeError, UnicodeError, RecursionError, ValueError:
        raise HTTPException(status_code=400, detail="request body must be valid JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return payload


def require_admitted_origin(request: Request, allowed_origins: Callable[[], frozenset[str]]) -> None:
    """Admit only an exactly canonical browser Origin: a header that merely normalizes into one grants nothing."""
    raw_origin = request.headers.get("origin")
    origin = chat_ws_common.canonical_origin(raw_origin)
    if origin is None or origin != raw_origin or origin not in allowed_origins():
        raise HTTPException(status_code=403, detail="browser origin is not admitted")


async def no_store(handler: Callable[[], Awaitable[JSONResponse]]) -> JSONResponse:
    """Answer without caching; a refusal is no-store too."""
    try:
        response = await handler()
    except HTTPException as exc:
        raise HTTPException(exc.status_code, exc.detail, headers={"Cache-Control": "no-store"}) from None
    response.headers["Cache-Control"] = "no-store"
    return response
