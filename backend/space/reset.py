"""Coordinate Local Space reset across Supervisor and Team authority."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from team import bridge as team


async def authenticated(
    request: Request, *, max_password_chars: int, read_json, recheck_password, team_response
) -> JSONResponse:
    """Require the current Supervisor password, within the sign-in budget and lockout, before Space reset."""
    payload = await read_json(request)
    if set(payload) != {"password"} or not isinstance(payload["password"], str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    password = payload["password"]
    if not 1 <= len(password) <= max_password_chars:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")
    await recheck_password(request, password)
    return await run_in_threadpool(team_response, team.reset_space)
