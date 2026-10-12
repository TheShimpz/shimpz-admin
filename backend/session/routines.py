"""A Team's Routines over the session socket (ADR-0114 tranche (c), ADR-0086).

Each method is the backend function its route ran, with the same validation, Team identity checks, and answers, on a
lane worker that checks the socket's Origin and session again when its turn comes.

Every Routine change Admin completes raises the Team's `routines` topic. A held run that resumes after a human answer
or a connected Integration is a long call on its own lane: it says once that it started and answers when Team does,
and a lost socket loses its result. A human answer is authenticated by chat's own Action-password authority, so both
share one lockout. Deleting a Routine is a confirmed operation bound to that exact Routine.
"""

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING

from fastapi import HTTPException
from session import lane, stepup, topics
from team import bridge as team
from team import http as team_http

from protocol.http.v1 import websocket as chat_ws_common
from routine import answer, manage

if TYPE_CHECKING:
    from session.socket import SessionSocket

Answer = lane.Answer


def _relayed(operation: Callable[..., team.TeamResponse], *args: object) -> team.TeamResponse:
    """Team's answer to one operation; a request Admin refused before Team is the page's own 400."""
    with team_http.refused_as_bad_request():
        return operation(*args)


def _settled(socket: SessionSocket, team_id: object, response: team.TeamResponse, *, wake: bool = False):
    """On the lane worker, as Team answers a Routine change: the sockets showing the Team's Routines read them again.

    It runs where the change completes, so it happens even when the socket that asked closed meanwhile. A 200 answer
    that made a Routine due now wakes the scheduler, which then claims at once instead of at its next interval.
    """
    if 200 <= response.status < 300:
        topics.team_changed(str(team_id), "routines")
    scheduler = getattr(socket.websocket.app.state, "routine_scheduler", None)
    if wake and response.status == 200 and scheduler is not None:
        scheduler.wake()
    return response


def _read(operation: str, *names: str):
    """A read of Team's Routine records, found when it runs so a test may stand in for it."""

    async def method(socket: SessionSocket, params: dict[str, object]) -> Answer:
        return await lane.run(socket, _relayed, getattr(manage, operation), *(params[name] for name in names))

    return method


def _change(owner: object, operation: str, *names: str, wake: bool = False):
    """A Routine change: Team's answer, the Team's `routines` topic on success, and the scheduler woken if asked."""

    def change(socket: SessionSocket, params: dict[str, object]) -> team.TeamResponse:
        response = _relayed(getattr(owner, operation), *(params[name] for name in names))
        return _settled(socket, params["team_id"], response, wake=wake)

    async def method(socket: SessionSocket, params: dict[str, object]) -> Answer:
        return await lane.run(socket, change, socket, params)

    return method


# Deleting a Routine: the password, then one second factor bound to this exact Routine (ADR-0051).


def _deletion_subject(params: dict[str, object]) -> str:
    try:
        return manage.deletion_subject(params["team_id"], params["routine_id"])
    except team.TeamRequestError as exc:
        raise HTTPException(status_code=400, detail="Routine is invalid") from exc


async def _deletion(socket: SessionSocket, params: dict[str, object]) -> Answer:
    try:
        subject = _deletion_subject(params)
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}
    return await stepup.begin(socket, subject, params["body"])


async def _delete(socket: SessionSocket, params: dict[str, object]) -> Answer:
    """Team is asked to delete the Routine only once the second factor confirmed this exact Routine."""
    try:
        subject = _deletion_subject(params)
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}

    def delete(_asker) -> team.TeamResponse:
        return _settled(socket, params["team_id"], _relayed(manage.delete, params["team_id"], params["routine_id"]))

    return await stepup.complete(socket, subject, params["body"], delete)


# A held run resuming: a long call on the Routine resume lane, never replayed.


def _started(socket: SessionSocket, call_id: str) -> Callable[[], None]:
    return lambda: socket.loop.call_soon_threadsafe(socket.progress, call_id)


def _answered(socket: SessionSocket, call_id: str, params: dict[str, object]) -> team.TeamResponse:
    """On the lane worker: authenticate the answer on the socket's loop, check the socket again, then resume the run.

    The Action password is checked by chat's own authority, so a wrong one spends the same lockout chat does.
    """
    try:
        checked = asyncio.run_coroutine_threadsafe(
            answer.authenticated(params["team_id"], params["run_id"], params["body"], socket.gate.authenticate),
            socket.loop,
        ).result()
    except team.TeamRequestError, chat_ws_common.FrameError:
        raise HTTPException(status_code=400, detail="human response is invalid") from None
    if isinstance(checked, team.TeamResponse):
        return checked
    if not lane.current(socket):
        raise lane.RefusedError
    _started(socket, call_id)()
    return _settled(socket, params["team_id"], answer.resume_answered(checked))


async def human(socket: SessionSocket, call_id: str, params: dict[str, object]) -> Answer:
    """Answer a held run's open challenge with chat's exact human-response frame; the run then resumes or ends."""
    return await lane.run(socket, _answered, socket, call_id, params, executor=lane.RESUME_LANE)


def _resumed(socket: SessionSocket, params: dict[str, object]) -> team.TeamResponse:
    response = _relayed(answer.resume_integrations, params["team_id"], params["run_id"])
    return _settled(socket, params["team_id"], response)


async def integrations(socket: SessionSocket, call_id: str, params: dict[str, object]) -> Answer:
    """After the Integration is connected, the held run continues from where it froze."""
    started = _started(socket, call_id)
    return await lane.run(socket, _resumed, socket, params, executor=lane.RESUME_LANE, started=started)


METHODS = {
    "routines.list": _read("list_routines", "team_id"),
    "routines.diagnostics": _read("diagnostics", "team_id", "run_id"),
    "routines.run_steps": _read("run_steps", "team_id", "run_id", "snapshot", "offset"),
    "routines.plan_steps": _read("plan_steps", "team_id", "routine_id", "revision", "offset"),
    "routines.pause": _change(manage, "pause", "team_id", "routine_id"),
    "routines.resume": _change(manage, "resume", "team_id", "routine_id"),
    "routines.deletion": _deletion,
    "routines.delete": _delete,
    "routines.card": _change(manage, "open_card", "team_id", "incident_id"),
    # Rodar makes the Routine due again.
    "routines.card_answer": _change(manage, "answer_card", "team_id", "incident_id", "body", wake=True),
    "routines.challenge": _change(answer, "open_challenge", "team_id", "run_id", "body"),
    # Criar rotina: a created Routine is due soon.
    "routines.proposal_confirm": _change(manage, "confirm_proposal", "team_id", "proposal_id", wake=True),
    "routines.proposal_revoke": _change(manage, "revoke_proposal", "team_id", "proposal_id"),
}
LONG_METHODS = {"routines.human": human, "routines.integrations": integrations}
