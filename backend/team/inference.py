"""Admin routes for a Team's inference settings: the model selection and the standing instructions (ADR-0083)."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from team import bridge as team
from team import http as team_http

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as chat_ws_common

log = logging.getLogger(__name__)
# Sixteen rules of 280 characters stay far below this even at four UTF-8 bytes per character plus JSON quoting.
MAX_INSTRUCTIONS_BODY_BYTES = 32 * 1024


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_status, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/inference", team_inference_configure, methods=["PUT"])
    app.add_api_route("/api/teams/{team_id}/instructions", team_instructions_status, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/instructions", team_instructions_configure, methods=["PUT"])


def team_inference_status(team_id: str):
    """Return only the Team's provider/model selection; credentials remain in this backend."""
    return team_http.response(lambda: team.get_inference(team_id))


async def team_inference_configure(team_id: str, request: Request):
    payload = await team_http.bounded_json_object(request)
    return await run_in_threadpool(team_http.response, lambda: team.configure_inference(team_id, payload))


def team_instructions_status(team_id: str):
    return team_http.response(lambda: get_instructions(team_id))


async def team_instructions_configure(team_id: str, request: Request):
    payload = await team_http.bounded_json_object(request, MAX_INSTRUCTIONS_BODY_BYTES)
    return await run_in_threadpool(team_http.response, lambda: configure_instructions(team_id, payload))


def _project_instructions(
    response: team.TeamResponse, team_id: str, *, expected: list[str] | None = None
) -> team.TeamResponse:
    """Project the authenticated controller envelope into the browser contract, never reflecting other fields."""
    if not 200 <= response.status < 300:
        return response
    body = response.body
    rules = (
        team_contract.canonical_instructions(body["instructions"])
        if isinstance(body, dict) and set(body) == {"team_id", "instructions", "trace_id"}
        else None
    )
    if (
        rules is None
        or rules != body["instructions"]
        or body["team_id"] != team_id
        or not isinstance(body["trace_id"], str)
        or chat_ws_common.HEX_ID_RE.fullmatch(body["trace_id"]) is None
        or (expected is not None and rules != expected)
    ):
        log.warning("team returned an invalid standing instructions response")
        return team.TeamResponse(502, {"detail": "Team instructions response is invalid."})
    return team.TeamResponse(response.status, {"team_id": team_id, "instructions": rules})


def get_instructions(team_id: object) -> team.TeamResponse:
    canonical_id = team.canonical_team_id(team_id)
    return _project_instructions(team._call("GET", f"/v1/teams/{canonical_id}/inference/instructions"), canonical_id)


def configure_instructions(team_id: object, payload: object) -> team.TeamResponse:
    """Forward only the closed standing-instruction list the Supervisor saved."""
    canonical_id = team.canonical_team_id(team_id)
    if not isinstance(payload, dict) or set(payload) != {"instructions"}:
        raise team.TeamRequestError("standing instructions require only instructions")
    rules = team_contract.canonical_instructions(payload["instructions"])
    if rules is None:
        raise team.TeamRequestError("use at most 16 distinct single-line instructions of at most 280 characters")
    response = team._call(
        "PUT",
        f"/v1/teams/{canonical_id}/inference/instructions",
        {"instructions": rules},
        max_body_bytes=MAX_INSTRUCTIONS_BODY_BYTES,
    )
    return _project_instructions(response, canonical_id, expected=rules)
