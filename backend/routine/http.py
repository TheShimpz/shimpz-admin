"""Admin routes for a Local Team's Routines (ADR-0086); Hosted has no Routines yet."""

from __future__ import annotations

import local_auth
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http

from protocol.http.v1 import websocket as chat_ws_common
from routine import answer, manage


def register(
    application: FastAPI,
    profile: str,
    authenticate: answer.Authenticate,
    confirmations: local_auth.Context,
) -> None:
    if profile != "local":
        return
    base = "/api/teams/{team_id}/routines"
    application.add_api_route(base, routines_list, methods=["GET"])
    application.add_api_route(base + "/{routine_id}/deletion", deletion_route(confirmations), methods=["POST"])
    application.add_api_route(base + "/{routine_id}", delete_route(confirmations), methods=["DELETE"])
    application.add_api_route(base + "/runs/{run_id}/diagnostics", routine_diagnostics, methods=["GET"])
    application.add_api_route(base + "/runs/{run_id}/steps/{snapshot}/{offset}", routine_run_steps, methods=["GET"])
    application.add_api_route(
        base + "/{routine_id}/revisions/{revision}/steps/{offset}", routine_plan_steps, methods=["GET"]
    )
    application.add_api_route(base + "/{routine_id}/resume", routine_resume, methods=["POST"])
    application.add_api_route(base + "/{routine_id}/pause", routine_pause, methods=["POST"])
    application.add_api_route(base + "/incidents/{incident_id}/card", routine_card, methods=["POST"])
    application.add_api_route(base + "/incidents/{incident_id}/answer", routine_card_answer, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/challenge", routine_challenge, methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/human", human_route(authenticate), methods=["POST"])
    application.add_api_route(base + "/runs/{run_id}/integrations", routine_integrations, methods=["POST"])
    application.add_api_route(base + "/proposals/{proposal_id}", routine_proposal_confirm, methods=["POST"])
    application.add_api_route(base + "/proposals/{proposal_id}", routine_proposal_revoke, methods=["DELETE"])


def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


async def _relay(call):
    """Team's answer to ``call``, made on a worker thread, never cached."""
    return _no_store(await run_in_threadpool(team_http.response, call))


def _wake_after(request: Request, response):
    """A 200 answer made a Routine due now, so the scheduler claims at once instead of at its next interval."""
    scheduler = getattr(request.app.state, "routine_scheduler", None)
    if response.status_code == 200 and scheduler is not None:
        scheduler.wake()
    return _no_store(response)


def routines_list(team_id: str):
    return _no_store(team_http.response(lambda: manage.list_routines(team_id)))


def _deletion_subject(team_id: str, routine_id: str) -> str:
    try:
        return manage.deletion_subject(team_id, routine_id)
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail="Routine is invalid") from exc


def deletion_route(confirmations: local_auth.Context):
    """Deleting a Routine starts with the Supervisor password, which offers the second factor bound to this Routine."""

    async def routine_deletion(team_id: str, routine_id: str, request: Request):
        async def begin() -> JSONResponse:
            subject = _deletion_subject(team_id, routine_id)
            try:
                return await local_auth.begin_operation(request, confirmations, subject)
            except local_auth.OperationRefusedError as exc:
                return local_auth.operation_refusal(exc)

        return await team_http.no_store(begin)

    return routine_deletion


def delete_route(confirmations: local_auth.Context):
    """Team is asked to delete the Routine only once the second factor confirmed this exact Routine (ADR-0051)."""

    async def routine_delete(team_id: str, routine_id: str, request: Request):
        async def delete() -> JSONResponse:
            subject = _deletion_subject(team_id, routine_id)
            payload = await team_http.bounded_json_object(request)
            # One worker confirms and then dispatches, so nothing runs between the session recheck and Team's request.
            try:
                response = await run_in_threadpool(
                    local_auth.confirm_operation,
                    request,
                    confirmations,
                    subject,
                    payload,
                    lambda: team_http.response(lambda: manage.delete(team_id, routine_id)),
                )
            except local_auth.OperationRefusedError as exc:
                response = local_auth.operation_refusal(exc)
            # The ticket is spent either way; a stale cookie would only be refused.
            response.delete_cookie(local_auth.TICKET_COOKIE, path="/api/")
            return response

        return await team_http.no_store(delete)

    return routine_delete


async def routine_diagnostics(team_id: str, run_id: str):
    return await _relay(lambda: manage.diagnostics(team_id, run_id))


async def routine_run_steps(team_id: str, run_id: str, snapshot: str, offset: str):
    return await _relay(lambda: manage.run_steps(team_id, run_id, snapshot, offset))


async def routine_plan_steps(team_id: str, routine_id: str, revision: str, offset: str):
    return await _relay(lambda: manage.plan_steps(team_id, routine_id, revision, offset))


async def routine_resume(team_id: str, routine_id: str):
    return await _relay(lambda: manage.resume(team_id, routine_id))


async def routine_pause(team_id: str, routine_id: str):
    return await _relay(lambda: manage.pause(team_id, routine_id))


async def routine_card(team_id: str, incident_id: str):
    return await _relay(lambda: manage.open_card(team_id, incident_id))


async def routine_card_answer(team_id: str, incident_id: str, request: Request):
    body = await team_http.bounded_json_object(request)
    # An answer made the Routine due again (Rodar now).
    return _wake_after(
        request, await run_in_threadpool(team_http.response, lambda: manage.answer_card(team_id, incident_id, body))
    )


async def routine_proposal_confirm(team_id: str, proposal_id: str, request: Request):
    """Criar rotina: the session's one confirmation of a card; a created Routine is due soon, so the scheduler wakes."""
    return _wake_after(
        request, await run_in_threadpool(team_http.response, lambda: manage.confirm_proposal(team_id, proposal_id))
    )


async def routine_proposal_revoke(team_id: str, proposal_id: str):
    """Cancelar: revoke a card."""
    return await _relay(lambda: manage.revoke_proposal(team_id, proposal_id))


async def routine_challenge(team_id: str, run_id: str, request: Request):
    body = await team_http.bounded_json_object(request)
    return await _relay(lambda: answer.open_challenge(team_id, run_id, body))


def human_route(authenticate: answer.Authenticate):
    """The answer route, bound to chat's one Local password authority so both share its lockout."""

    async def routine_human(team_id: str, run_id: str, request: Request):
        body = await team_http.bounded_json_object(request)
        try:
            result = await answer.answer(team_id, run_id, body, authenticate)
        except (team.TeamRequestError, chat_ws_common.FrameError) as exc:
            raise HTTPException(status_code=400, detail="human response is invalid") from exc
        return _no_store(JSONResponse(status_code=result.status, content=result.body))

    return routine_human


async def routine_integrations(team_id: str, run_id: str):
    return await _relay(lambda: answer.resume_integrations(team_id, run_id))
