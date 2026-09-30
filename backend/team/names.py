"""Local Team names (ADR-0088): create under a free id, and rename a Team without changing its id.

Only the Local profile registers these: a Hosted Team keeps its immutable name.
"""

from __future__ import annotations

import logging
import unicodedata
from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from history import http as chat_history_http
from starlette.concurrency import run_in_threadpool
from team import bridge
from team import http as team_http

from protocol.http.v1 import websocket as chat_ws_common

MAX_TEAM_RENAME_BODY_BYTES = 1024
# A recreated name whose id a renamed Team still holds gets the next free suffix: marketing, marketing_2 ... _9.
MAX_ID_SUFFIX = 9
ID_SUFFIX_BASE_CHARS = 38
log = logging.getLogger("shimpz-admin")


def _team_name(payload: dict) -> str:
    if set(payload) != {"team_name"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name")
    if not isinstance(payload["team_name"], str):
        raise HTTPException(status_code=400, detail="team name must be a string")
    try:
        return bridge.canonical_local_team_name(unicodedata.normalize("NFC", payload["team_name"].strip()))
    except bridge.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


def _candidate_ids(team_name: str) -> list[str]:
    base = bridge.to_team_id(team_name)
    if not base:
        raise HTTPException(status_code=400, detail="team name has no usable characters")
    stem = base[:ID_SUFFIX_BASE_CHARS].rstrip("_")
    return [base, *(f"{stem}_{suffix}" for suffix in range(2, MAX_ID_SUFFIX + 1))]


def _create(team_name: str) -> tuple[str, bridge.TeamResponse]:
    """Try the name's id, then its suffixes, only while each is held by a Team with another current name."""
    for team_id in _candidate_ids(team_name):
        response = bridge.create(team_id, team_name)
        if response.status != 409 or response.body.get("code") != "team-name-conflict":
            return team_id, response
    return team_id, response


def create(payload: dict) -> JSONResponse:
    team_name = _team_name(payload)
    team_id, result = _create(team_name)
    result = chat_history_http.team_created(team_id, result)
    response = team_http.response(lambda: result)
    if 200 <= response.status_code < 300:
        log.info("team created: %s", team_id)
    return response


def register(app: FastAPI, allowed_origins: Callable[[], frozenset[str]]) -> None:
    async def rename(team_id: str, request: Request) -> JSONResponse:
        raw_origin = request.headers.get("origin")
        origin = chat_ws_common.canonical_origin(raw_origin)
        # Only an exactly canonical Origin is admitted: a header that merely normalizes into one grants nothing.
        if origin is None or origin != raw_origin or origin not in allowed_origins():
            raise HTTPException(status_code=403, detail="browser origin is not admitted")
        team_name = _team_name(await team_http.bounded_json_object(request, MAX_TEAM_RENAME_BODY_BYTES))
        return await run_in_threadpool(team_http.response, lambda: bridge.rename(team_id, team_name))

    async def team_rename(team_id: str, request: Request) -> JSONResponse:
        """Rename a Team; every answer, including a refusal, is no-store."""
        try:
            response = await rename(team_id, request)
        except HTTPException as exc:
            raise HTTPException(exc.status_code, exc.detail, headers={"Cache-Control": "no-store"}) from None
        response.headers["Cache-Control"] = "no-store"
        return response

    app.add_api_route("/api/teams/{team_id}", team_rename, methods=["PATCH"])
