"""Same-origin projection of verified binary assets held by Team."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response
from team import bridge


def _response(action) -> Response:
    try:
        result = action()
    except bridge.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if result.contents is None:
        return JSONResponse(status_code=result.status, content=result.error)
    return Response(
        content=result.contents,
        status_code=result.status,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def assistant_icon(team_id: str, assistant_id: str) -> Response:
    return _response(lambda: bridge.assistant_icon(team_id, assistant_id))
