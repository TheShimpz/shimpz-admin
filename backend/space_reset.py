"""Coordinate Local Space reset across Supervisor and Team authority."""

from __future__ import annotations

import asyncio
import logging

import auth
import state
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from team import bridge as team

log = logging.getLogger("shimpz-admin")


def _response(status: int, body: dict[str, object]) -> JSONResponse:
    response = JSONResponse(body, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    return response


async def bootstrap(request: Request, *, setup_lock: asyncio.Lock, read_json, team_response) -> JSONResponse:
    """Reset only while fail-loud Admin and Team authority prove no Supervisor exists."""
    payload = await read_json(request)
    if payload:
        raise HTTPException(status_code=400, detail="request body must be an empty object")
    if setup_lock.locked():
        return _response(
            409,
            {
                "code": "bootstrap-reset-busy",
                "detail": "Supervisor setup or bootstrap reset is already in progress; nothing was deleted",
            },
        )
    await setup_lock.acquire()
    try:
        if state.is_initialized():
            return _response(
                409,
                {
                    "code": "supervisor-password-required",
                    "detail": "Supervisor password is configured",
                },
            )
        response = await run_in_threadpool(team_response, team.bootstrap_reset_space)
        response.headers["Cache-Control"] = "no-store"
        return response
    finally:
        setup_lock.release()


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
        raise HTTPException(status_code=403, detail="Supervisor password is incorrect")
    return await run_in_threadpool(team_response, team.reset_space)
