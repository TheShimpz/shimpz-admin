"""Admission of the JSON object a browser request carries."""

import json

from fastapi import HTTPException, Request

from protocol.http.v1 import strict_json


def exact_fields(payload: dict, *names: str) -> dict:
    """Return `payload` when it holds exactly the fields `names`; any other body is the request's own 400."""
    if set(payload) != set(names):
        raise HTTPException(status_code=400, detail=f"request body must contain only {' and '.join(names)}")
    return payload


async def bounded_json_object(request: Request, max_bytes: int) -> dict:
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
        payload = strict_json.loads(body)
    except json.JSONDecodeError, UnicodeError, RecursionError, ValueError:
        raise HTTPException(status_code=400, detail="request body must be valid JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return payload
