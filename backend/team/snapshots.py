"""Local-only same-origin projection of staged Assistant snapshots: inventory, icon, and localized summary."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from team import assets as team_assets
from team import bridge as team
from team import http as team_http

from protocol.http.v1 import payload as team_contract


def register(app: FastAPI, profile: str) -> None:
    """Staged snapshots exist only in the Local profile; Hosted never exposes these routes."""
    if profile != "local":
        return
    app.add_api_route("/api/local-assistants", local_assistants_list, methods=["GET"])
    app.add_api_route("/api/local-assistants/{image_hash}/icon", team_assets.local_assistant_icon, methods=["GET"])
    app.add_api_route("/api/local-assistants/{image_hash}/summary", local_assistant_summary, methods=["GET"])


def local_assistants_list() -> JSONResponse:
    return team_http.response(team.list_local_assistants)


def local_assistant_summary(image_hash: str, locale: str = "") -> JSONResponse:
    """One staged snapshot's summary in the interface language, from its own pack (ADR-0091).

    Team's answer must be exactly the snapshot summary in the requested locale; a busy preview passes its retry hint
    through unchanged, and any other failure keeps Team's bounded status and code.
    """
    canonical = team_contract.canonical_locale(locale)
    if canonical is None:
        raise HTTPException(status_code=422, detail="Assistant summary locale is invalid")
    try:
        result = team.local_assistant_summary(f"sha256:{image_hash}", canonical)
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if result.status != 200:
        return JSONResponse(status_code=result.status, content=result.body)
    body = {key: value for key, value in result.body.items() if key != "trace_id"}
    summary = team_contract.canonical_snapshot_summary(body)
    if summary is None or summary["locale"] != canonical:
        raise HTTPException(status_code=502, detail="Local Assistant summary is invalid")
    return JSONResponse(content=summary, headers={"Cache-Control": "no-store"})
