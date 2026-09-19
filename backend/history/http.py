"""Authenticated HTTP projection and lifecycle cleanup for Local chat history."""

from __future__ import annotations

import logging
from collections.abc import Callable

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from history import store
from team import bridge as team
from team import http as team_http

log = logging.getLogger("shimpz-admin")


def cleanup(response: team.TeamResponse, action: Callable[[], object]) -> team.TeamResponse:
    if not 200 <= response.status < 300:
        return response
    try:
        action()
    except store.HistoryUnavailableError:
        log.exception("Admin chat history cleanup is unavailable")
        return team.TeamResponse(
            503,
            {"detail": "Team state changed, but Admin chat history cleanup did not complete"},
        )
    return response


def team_created(team_id: str, response: team.TeamResponse) -> team.TeamResponse:
    if not isinstance(response.body, dict) or response.body.get("created") is not True:
        return response
    return cleanup(response, lambda: store.clear_team(team_id))


def team_delete(team_id: str, action: Callable[[], team.TeamResponse]) -> team.TeamResponse:
    response = action()
    if response == team.TeamResponse(404, {"detail": "Team not found"}):
        response = team.TeamResponse(200, {"deleted": False})
    return cleanup(response, lambda: store.clear_team(team_id))


def space_reset(action: Callable[[], team.TeamResponse]) -> team.TeamResponse:
    return cleanup(action(), store.clear_all)


def page(team_id: str, before: str | None = None) -> JSONResponse:
    try:
        resolved = team.resolve_team_name(team_id)
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if isinstance(resolved, team.TeamResponse):
        return team_http.response(lambda: resolved)
    try:
        response = JSONResponse(store.page(team_id, before=before))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except store.HistoryUnavailableError:
        log.exception("Admin chat history is unavailable")
        raise HTTPException(status_code=503, detail="Admin chat history is unavailable") from None
    response.headers["Cache-Control"] = "no-store"
    return response
