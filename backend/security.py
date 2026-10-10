"""The Supervisor's own view of its sign-in security (ADR-0051).

It holds the sign-in before this one and the refused attempts since (read back from the authentication journal), the
reported second-factor failures, and the recovery codes left. A successful sign-in reports the second-factor attempts
refused since the previous one, and Admin keeps reporting them after every later sign-in until the Supervisor
acknowledges them. An acknowledgment names how many it saw, so a refusal that arrives while the report is on screen is
never dismissed unseen.
"""

import logging

import auth
import state
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from team import http as team_http

import audit

log = logging.getLogger("shimpz-admin")
MAX_BODY_BYTES = 1024
SESSION_COOKIE = "shimpz_admin"


def register(app: FastAPI) -> None:
    app.add_api_route("/api/admin/security", summary, methods=["GET"])
    app.add_api_route("/api/admin/security/failures", acknowledge_failures, methods=["POST"])


def _response(body: dict[str, object]) -> JSONResponse:
    response = JSONResponse(body)
    response.headers["Cache-Control"] = "no-store"
    return response


def _history(session: str) -> dict[str, object] | None:
    """The sign-in before this session's and the refused attempts since, or None while the journal is unreadable."""
    evidence = auth.verify_session(state.get()["session_secret"], session)
    if evidence is None:
        raise HTTPException(status_code=401, detail="unauthenticated")
    try:
        return audit.sign_in_history(evidence.issued_at)
    except OSError, audit.HistoryUnavailableError:
        log.warning("Local Supervisor sign-in history is unavailable")
        return None


def _summary(session: str) -> dict[str, object]:
    return {
        "failed_second_factor_attempts": state.unacknowledged_second_factor_failures(),
        "recovery_codes_remaining": state.recovery_codes_remaining(),
        "sign_in_history": _history(session),
    }


async def summary(request: Request) -> JSONResponse:
    return _response(await run_in_threadpool(_summary, request.cookies.get(SESSION_COOKIE, "")))


async def acknowledge_failures(request: Request) -> JSONResponse:
    payload = await team_http.bounded_json_object(request, MAX_BODY_BYTES)
    count = payload.get("acknowledged") if set(payload) == {"acknowledged"} else None
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= state.MAX_SECOND_FACTOR_FAILURES:
        raise HTTPException(status_code=400, detail="request body must contain only a positive acknowledged count")
    await run_in_threadpool(state.acknowledge_second_factor_failures, count)
    return await summary(request)
