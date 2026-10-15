"""Bounded same-origin HTTP adaptation for Team controller responses."""

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from team import transport


@contextmanager
def refused_as_bad_request() -> Iterator[None]:
    """Answer a request Admin refused before any Team call as the browser's own 400, with the refusal's reason."""
    try:
        yield
    except transport.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


def response(action) -> JSONResponse:
    with refused_as_bad_request():
        result = action()
    return JSONResponse(status_code=result.status, content=result.body)
