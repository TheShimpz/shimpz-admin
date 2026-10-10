"""The Supervisor's own view of its sign-in security (ADR-0051).

A successful sign-in reports the second-factor attempts refused since the previous one, and Admin keeps reporting them
after every later sign-in until the Supervisor acknowledges them. An acknowledgment names how many it saw, so a refusal
that arrives while the report is on screen is never dismissed unseen.
"""

import state
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from team import http as team_http

MAX_BODY_BYTES = 1024


def register(app: FastAPI) -> None:
    app.add_api_route("/api/admin/security", summary, methods=["GET"])
    app.add_api_route("/api/admin/security/failures", acknowledge_failures, methods=["POST"])


def _response(body: dict[str, object]) -> JSONResponse:
    response = JSONResponse(body)
    response.headers["Cache-Control"] = "no-store"
    return response


async def summary() -> JSONResponse:
    failures = await run_in_threadpool(state.unacknowledged_second_factor_failures)
    return _response({"failed_second_factor_attempts": failures})


async def acknowledge_failures(request: Request) -> JSONResponse:
    payload = await team_http.bounded_json_object(request, MAX_BODY_BYTES)
    count = payload.get("acknowledged") if set(payload) == {"acknowledged"} else None
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= state.MAX_SECOND_FACTOR_FAILURES:
        raise HTTPException(status_code=400, detail="request body must contain only a positive acknowledged count")
    remaining = await run_in_threadpool(state.acknowledge_second_factor_failures, count)
    return _response({"failed_second_factor_attempts": remaining})
