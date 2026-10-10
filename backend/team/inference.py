"""Admin routes for a Team's settings: the model selection with its reasoning effort, and Action confirmation."""

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from team import bridge as team
from team import http as team_http


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_status, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_configure, methods=["PUT"])
    app.add_api_route("/api/teams/{team_id}/action-confirmation", action_confirmation_status, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/action-confirmation", action_confirmation_configure, methods=["PUT"])


def team_inference_status(team_id: str):
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return team_http.response(lambda: team.get_inference(team_id))


async def team_inference_configure(team_id: str, request: Request):
    payload = await team_http.bounded_json_object(request)
    return await run_in_threadpool(team_http.response, lambda: team.configure_inference(team_id, payload))


def action_confirmation_status(team_id: str):
    """Whether Team confirms the Team's mutating Actions before they run (ADR-0112); on unless turned off."""
    return team_http.response(lambda: team.get_action_confirmation(team_id))


async def action_confirmation_configure(team_id: str, request: Request):
    payload = await team_http.bounded_json_object(request)
    return await run_in_threadpool(team_http.response, lambda: team.configure_action_confirmation(team_id, payload))
