"""Local Team names (ADR-0088): create under a free id, rename without changing the id, and delete by exact name.

Each operation that changed the Team list raises its `teams` topic for the session sockets that show it.
"""

import logging
import unicodedata

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from history import http as chat_history_http
from session import topics
from signin import auth
from team import bridge
from team import http as team_http
from team import order as team_order

# A recreated name whose id a renamed Team still holds gets the next free suffix: marketing, marketing_2 ... _9.
MAX_ID_SUFFIX = 9
ID_SUFFIX_BASE_CHARS = 38
log = logging.getLogger("shimpz-admin")


def _team_name(payload: dict) -> str:
    if set(payload) != {"team_name"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name")
    if not isinstance(payload["team_name"], str):
        raise HTTPException(status_code=400, detail="team name must be a string")
    with team_http.refused_as_bad_request():
        return bridge.canonical_local_team_name(unicodedata.normalize("NFC", payload["team_name"].strip()))


def _candidate_ids(team_name: str) -> list[str]:
    base = bridge.to_team_id(team_name)
    if not base:
        raise HTTPException(status_code=400, detail="team name has no usable characters")
    stem = base[:ID_SUFFIX_BASE_CHARS].rstrip("_")
    return [base, *(f"{stem}_{suffix}" for suffix in range(2, MAX_ID_SUFFIX + 1))]


def _create(team_name: str) -> tuple[str, bridge.TeamResponse]:
    """Try the name's id, then its suffixes, only while each is held by a Team with another current name.

    Creation holds the Team order lock, and an id that no Team holds first loses any position it kept saved.
    """
    with team_order.LOCK:
        for team_id in _candidate_ids(team_name):
            response = team_order.release_for_create(team_id) or bridge.create(team_id, team_name)
            if response.status != 409 or response.body.get("code") != "team-name-conflict":
                return team_id, response
        return team_id, response


def _changed(response: JSONResponse) -> JSONResponse:
    if 200 <= response.status_code < 300:
        topics.changed("teams")
    return response


def create(payload: dict) -> JSONResponse:
    team_name = _team_name(payload)
    team_id, result = _create(team_name)
    result = chat_history_http.team_created(team_id, result)
    response = team_http.response(lambda: result)
    if 200 <= response.status_code < 300:
        log.info("team created: %s", team_id)
    return _changed(response)


def rename(team_id: str, payload: dict) -> JSONResponse:
    team_name = _team_name(payload)
    return _changed(team_http.response(lambda: bridge.rename(team_id, team_name)))


def deletion(payload: dict) -> tuple[str, str]:
    """The exact Team name and Supervisor password a deletion confirms, as the browser sent them."""
    if set(payload) != {"team_name", "password"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_name and password")
    team_name = payload["team_name"]
    password = payload["password"]
    if not isinstance(team_name, str) or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="Team name and password must be strings")
    if not 1 <= len(password) <= auth.MAX_PASSWORD_CHARS:
        raise HTTPException(status_code=400, detail="Supervisor password is invalid")
    return team_name, password


def _deleted_with_history(team_id: str, team_name: str) -> bridge.TeamResponse:
    with team_order.LOCK:
        response = chat_history_http.team_delete(team_id, lambda: bridge.destroy_confirmed(team_id, team_name))
        return team_order.team_deleted(team_id, response)


def delete(team_id: str, team_name: str) -> JSONResponse:
    """Delete the Team its exact current name confirms, with its history and its saved list position."""
    return _changed(team_http.response(lambda: _deleted_with_history(team_id, team_name)))
