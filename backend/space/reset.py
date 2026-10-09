"""Coordinate Local Space reset across Supervisor and Team authority."""

import asyncio
import logging

import auth
import state
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from team import bridge as team

import audit
from protocol.http.v1.websocket import canonical_origin

log = logging.getLogger("shimpz-admin")


async def authenticated(request: Request, *, max_password_chars: int, read_json, team_response) -> JSONResponse:
    """Require the current Supervisor password before established-Space reset."""
    payload = await read_json(request)
    if set(payload) != {"password"} or not isinstance(payload["password"], str):
        raise HTTPException(status_code=400, detail="request body must contain only password")
    password = payload["password"]
    if not 1 <= len(password) <= max_password_chars:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")
    record = state.get()
    try:
        password_ok = await asyncio.to_thread(
            auth.verify_password,
            password,
            record,
        )
    except auth.PasswordRecordError, TypeError, ValueError:
        log.warning("Admin password record is invalid")
        raise HTTPException(status_code=503, detail="Supervisor password verification is unavailable") from None
    if not password_ok:
        log.info("Space reset password confirmation failed")
        audit.record("password-rejected", outcome="denied", origin=canonical_origin(request.headers.get("origin")))
        raise HTTPException(status_code=403, detail="Supervisor password is incorrect")
    return await run_in_threadpool(team_response, team.reset_space)
