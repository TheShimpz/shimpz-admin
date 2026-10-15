"""Coordinate Local Space reset across Supervisor and Team authority."""

import request_body
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from signin import audit, auth
from starlette.concurrency import run_in_threadpool
from team import bridge as team

from protocol.http.v1.websocket import canonical_origin


async def authenticated(request: Request, *, read_json, recheck_password, team_response) -> JSONResponse:
    """Require the current Supervisor password, within the sign-in budget and lockout, before Space reset."""
    password = request_body.exact_fields(await read_json(request), "password")["password"]
    if not isinstance(password, str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    if not 1 <= len(password) <= auth.MAX_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")
    origin = canonical_origin(request.headers.get("origin"))
    await recheck_password(origin, password)
    # Journaled before Team, history, or the saved order changes: an unwritable journal refuses the reset.
    audit.record("space-reset", outcome="ok", origin=origin)
    return await run_in_threadpool(team_response, team.reset_space)
