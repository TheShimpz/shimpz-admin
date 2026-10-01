"""Same-origin projection of one Assistant summary in one interface language, read by Team from a pack (ADR-0091)."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from team import bridge as team

from protocol.http.v1 import payload as team_contract


def register(app: FastAPI) -> None:
    """An installed Assistant's summary is read in both profiles."""
    app.add_api_route("/api/teams/{team_id}/assistants/{assistant_id}/summary", assistant_summary, methods=["GET"])


def localized(read: Callable[[str], team.TeamResponse], locale: str, subject: str) -> JSONResponse:
    """Answer exactly Team's summary in the requested locale, never another language.

    A Team failure keeps its bounded status, code, and any retry hint; an answer outside the closed shape or in another
    locale fails as invalid.
    """
    canonical = team_contract.canonical_locale(locale)
    if canonical is None:
        raise HTTPException(status_code=422, detail="Assistant summary locale is invalid")
    try:
        result = read(canonical)
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if result.status != 200:
        return JSONResponse(status_code=result.status, content=result.body)
    body = {key: value for key, value in result.body.items() if key != "trace_id"}
    summary = team_contract.canonical_snapshot_summary(body)
    if summary is None or summary["locale"] != canonical:
        raise HTTPException(status_code=502, detail=f"{subject} summary is invalid")
    return JSONResponse(content=summary, headers={"Cache-Control": "no-store"})


def assistant_summary(team_id: str, assistant_id: str, locale: str = "") -> JSONResponse:
    """One installed Assistant's summary in the interface language, from its binding's own pack."""
    return localized(lambda canonical: team.assistant_summary(team_id, assistant_id, canonical), locale, "Assistant")
