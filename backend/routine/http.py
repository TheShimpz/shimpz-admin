"""Admin routes for a Local Team's Routines (ADR-0086); Hosted has no Routines yet."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http

from protocol.http.v1 import websocket as chat_ws_common
from routine import answer, manage


def register(application: FastAPI, profile: str, authenticate: answer.Authenticate) -> None:
    if profile != "local":
        return
    base = "/api/teams/{team_id}/routines"
    application.add_api_route(base, routines_list, methods=["GET"])
    application.add_api_route(base, routine_confirm, methods=["POST"])
    application.add_api_route(base + "/proposals/{proposal_id}/preview", routine_preview, methods=["POST"])
    application.add_api_route(base + "/{routine_id}", routine_delete, methods=["DELETE"])
    application.add_api_route(base + "/runs/{run_id}/stop", routine_stop, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/resolve", routine_resolve, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/challenge", routine_challenge, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/human", human_route(authenticate), methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/integrations", routine_integrations, methods=["POST"])


def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def routines_list(team_id: str):
    return _no_store(team_http.response(lambda: manage.list_routines(team_id)))


async def routine_preview(team_id: str, proposal_id: str, request: Request):
    body = await team_http.bounded_json_object(request)
    return _no_store(await run_in_threadpool(team_http.response, lambda: manage.preview(team_id, proposal_id, body)))


async def routine_confirm(team_id: str, request: Request):
    body = await team_http.bounded_json_object(request)
    return _no_store(await run_in_threadpool(team_http.response, lambda: manage.confirm(team_id, body)))


async def routine_delete(team_id: str, routine_id: str):
    return _no_store(await run_in_threadpool(team_http.response, lambda: manage.delete(team_id, routine_id)))


async def routine_stop(team_id: str, run_id: str):
    return _no_store(await run_in_threadpool(team_http.response, lambda: manage.stop(team_id, run_id)))


async def routine_resolve(team_id: str, run_id: str, request: Request):
    body = await team_http.bounded_json_object(request)
    return _no_store(await run_in_threadpool(team_http.response, lambda: manage.resolve(team_id, run_id, body)))


async def routine_challenge(team_id: str, run_id: str):
    return _no_store(await run_in_threadpool(team_http.response, lambda: answer.open_challenge(team_id, run_id)))


def human_route(authenticate: answer.Authenticate):
    """The answer route, bound to chat's one Local password authority so both share its lockout."""

    async def routine_human(team_id: str, run_id: str, request: Request):
        body = await team_http.bounded_json_object(request)
        try:
            result = await answer.answer(team_id, run_id, body, authenticate)
        except (team.TeamRequestError, chat_ws_common.FrameError) as exc:
            raise HTTPException(status_code=400, detail="human response is invalid") from exc
        return _no_store(JSONResponse(status_code=result.status, content=result.body))

    return routine_human


async def routine_integrations(team_id: str, run_id: str):
    return _no_store(await run_in_threadpool(team_http.response, lambda: answer.resume_integrations(team_id, run_id)))
