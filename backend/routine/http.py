"""Admin routes for a Local Team's Routines (ADR-0086); Hosted has no Routines yet."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from team import http as team_http

from routine import manage


def register(application: FastAPI, profile: str) -> None:
    if profile != "local":
        return
    base = "/api/teams/{team_id}/routines"
    application.add_api_route(base, routines_list, methods=["GET"])
    application.add_api_route(base, routine_confirm, methods=["POST"])
    application.add_api_route(base + "/proposals/{proposal_id}/preview", routine_preview, methods=["POST"])
    application.add_api_route(base + "/{routine_id}", routine_delete, methods=["DELETE"])
    application.add_api_route(base + "/runs/{run_id}/stop", routine_stop, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/resolve", routine_resolve, methods=["POST"])


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
