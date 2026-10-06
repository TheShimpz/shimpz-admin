"""Same-origin projection of verified binary assets held by Team."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from team import bridge
from team import http as team_http


def _response(action) -> Response:
    with team_http.refused_as_bad_request():
        result = action()
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


def register(app: FastAPI) -> None:
    """An installed Assistant's icon is read in both profiles."""
    app.add_api_route("/api/teams/{team_id}/assistants/{assistant_id}/icon", assistant_icon, methods=["GET"])


def assistant_icon(team_id: str, assistant_id: str) -> Response:
    return _response(lambda: bridge.assistant_icon(team_id, assistant_id))


def local_assistant_icon(image_hash: str) -> Response:
    return _response(lambda: bridge.local_assistant_icon(f"sha256:{image_hash}"))
