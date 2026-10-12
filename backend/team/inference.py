"""A Team's inference settings as session calls: the model selection."""

from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http


def status(team_id: str) -> JSONResponse:
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return team_http.response(lambda: team.get_inference(team_id))


def configure(team_id: str, payload: dict) -> JSONResponse:
    return team_http.response(lambda: team.configure_inference(team_id, payload))
