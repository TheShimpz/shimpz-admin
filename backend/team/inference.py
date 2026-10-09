"""Admin routes for a Team's inference settings: the model selection and its chat reasoning effort."""

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from team import bridge as team
from team import http as team_http


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_status, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_configure, methods=["PUT"])


def team_inference_status(team_id: str):
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return team_http.response(lambda: team.get_inference(team_id))


async def team_inference_configure(team_id: str, request: Request):
    payload = await team_http.bounded_json_object(request)
    return await run_in_threadpool(team_http.response, lambda: team.configure_inference(team_id, payload))
