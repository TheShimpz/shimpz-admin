"""A Team's settings as session calls: the model selection and Action confirmation (ADR-0112)."""

from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http


def status(team_id: str) -> JSONResponse:
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return team_http.response(lambda: team.get_inference(team_id))


def configure(team_id: str, payload: dict) -> JSONResponse:
    return team_http.response(lambda: team.configure_inference(team_id, payload))


def action_confirmation_status(team_id: str) -> JSONResponse:
    """Whether Team confirms the Team's mutating Actions before they run (ADR-0112); on unless turned off."""
    return team_http.response(lambda: team.get_action_confirmation(team_id))


def action_confirmation_configure(team_id: str, payload: dict) -> JSONResponse:
    return team_http.response(lambda: team.configure_action_confirmation(team_id, payload))
