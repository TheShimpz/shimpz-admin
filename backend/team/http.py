"""Bounded same-origin HTTP adaptation for Team controller responses."""

from __future__ import annotations

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from protocol.http.v1 import websocket as chat_ws_common
from team import bridge


def response(action) -> JSONResponse:
    try:
        result = action()
    except bridge.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
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
