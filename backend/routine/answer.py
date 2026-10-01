"""A Local Supervisor answers a frozen Routine run (ADR-0086) exactly as chat answers a paused turn.

Opening a frozen run's notice asks Team for a fresh one-use challenge; Admin keeps its request until it expires, so an
answer is checked against it and an authentication request is verified here, as in chat, before the run resumes under
the Supervisor's session with the Team's model key.
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from collections.abc import Awaitable, Callable
from http import HTTPStatus

from team import bridge as team
from team import transport

from chat import human
from chat import local as chat_local
from protocol.http.v1 import websocket as chat_ws_common
from routine import manage
from routine import team as routine_team

_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
MAX_OPEN_CHALLENGES = 64
_CHALLENGES: dict[tuple[str, str, str], tuple[float, dict[str, object]]] = {}
_CHALLENGES_LOCK = threading.Lock()
Authenticate = Callable[[str, str], Awaitable[human.AuthenticationResult]]


def _run(team_id: object, run_id: object) -> tuple[str, str]:
    canonical = team.canonical_team_id(team_id)
    if not isinstance(run_id, str) or _ID_RE.fullmatch(run_id) is None:
        raise team.TeamRequestError("Routine run is invalid")
    return canonical, run_id


def _remember(key: tuple[str, str, str], deadline: float, request: dict[str, object]) -> None:
    now = time.monotonic()
    with _CHALLENGES_LOCK:
        for stale in [item for item, (deadline, _request) in _CHALLENGES.items() if deadline <= now]:
            del _CHALLENGES[stale]
        # One Routine challenge per Team at a time, as Team keeps it; the newest replaces the Team's earlier one.
        for earlier in [item for item in _CHALLENGES if item[0] == key[0]]:
            del _CHALLENGES[earlier]
        if len(_CHALLENGES) >= MAX_OPEN_CHALLENGES:
            _CHALLENGES.pop(next(iter(_CHALLENGES)))
        _CHALLENGES[key] = (deadline, request)


def _take(key: tuple[str, str, str]) -> tuple[float, dict[str, object]] | None:
    with _CHALLENGES_LOCK:
        entry = _CHALLENGES.pop(key, None)
    return entry if entry is not None and entry[0] > time.monotonic() else None


def open_challenge(team_id: object, run_id: object) -> team.TeamResponse:
    """A person opened a frozen run's notice: its fresh challenge, or that it waits for an Integration."""
    canonical, run = _run(team_id, run_id)
    response = transport._call("POST", f"/v1/teams/{canonical}/routines/runs/{run}/challenge", {})
    if response.status != 200 or not isinstance(response.body, dict):
        return manage._projected(response, lambda _body: None)
    body = dict(response.body)
    if set(body) == {"team_id", "run_id", "status", "trace_id"} and body["status"] == "integrations-required":
        return manage._projected(
            response, lambda value: value if (value["team_id"], value["run_id"]) == (canonical, run) else None
        )
    if body.pop("run_id", None) != run:
        return manage._INVALID
    try:
        projected = human.project(body, canonical)
    except human.HumanChallengeError:
        return manage._INVALID
    deadline = time.monotonic() + projected["expires_in"]
    _remember((canonical, run, projected["challenge_id"]), deadline, projected["request"])
    challenge = {
        "type": "human-required",
        **{
            name: projected[name]
            for name in ("challenge_id", "expires_in", "assistant", "action", "request", "purpose", "help_url")
            if name in projected
        },
    }
    return team.TeamResponse(
        HTTPStatus.OK, {"team_id": canonical, "run_id": run, "status": "human-required", "challenge": challenge}
    )


def _resumed(response: team.TeamResponse, canonical: str, run: str) -> team.TeamResponse:
    def admit(value: dict[str, object]) -> dict[str, object] | None:
        valid = (
            set(value) == {"team_id", "run_id", "status"}
            and (value["team_id"], value["run_id"]) == (canonical, run)
            and value["status"] in routine_team.RUN_STATUSES
        )
        return value if valid else None

    return manage._projected(response, admit)


def _resume(canonical: str, run: str, action: str, payload: dict[str, object], assurance) -> team.TeamResponse:
    credential = chat_local.model_credential(canonical)
    if isinstance(credential, team.TeamResponse):
        return credential
    response = transport._call_stream(
        "POST",
        f"/v1/teams/{canonical}/routines/runs/{run}/{action}",
        payload,
        timeout=routine_team.RUN_TIMEOUT_SECONDS,
        bindings=transport._RequestBindings(model_credential=credential, human_assurance=assurance),
        progress=lambda _event: None,
    )
    return _resumed(response, canonical, run)


async def answer(team_id: object, run_id: object, frame: object, authenticate: Authenticate) -> team.TeamResponse:
    """One exact answer to the run's open challenge; the run then resumes, or ends denied."""
    canonical, run = _run(team_id, run_id)
    canonical_frame = chat_ws_common.canonical_human_response(frame)
    key = (canonical, run, canonical_frame["challenge_id"])
    opened = _take(key)
    if opened is None:
        return team.TeamResponse(HTTPStatus.CONFLICT, {"code": "human-request-expired"})
    deadline, request = opened
    payload, assurance, rejection, failure = await human.response_payload(dict(frame), request, authenticate)
    if rejection is not None:
        # A wrong password keeps the challenge open until its own expiry for another attempt, as in chat.
        _remember(key, deadline, request)
        return team.TeamResponse(HTTPStatus.CONFLICT, {"code": rejection["reason"], **rejection})
    # The run replays for up to its active time; the Supervisor's session binding travels with the worker thread.
    result = await asyncio.to_thread(_resume, canonical, run, "human", payload, assurance)
    if failure is not None:
        return team.TeamResponse(failure[0], {"code": "human-authentication-unavailable"})
    return result


def resume_integrations(team_id: object, run_id: object) -> team.TeamResponse:
    """After the Integration is connected, the run continues from where it froze."""
    canonical, run = _run(team_id, run_id)
    return _resume(canonical, run, "integrations", {}, None)
