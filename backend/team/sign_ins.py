"""A Team's Sign-ins for the Supervisor (ADR-0117, Sign-ins amendment).

The Supervisor starts a sign-in session at one https site, drives its Browser through the view's control stream, and
Saves it as a Sign-in with a label of their own, or cancels it; they list the Team's Sign-ins and forget one. Every
body is checked against Team's protocol before Team is reached, and every answer of Team's is admitted only in its
exact form with its trace identifier, which the page never receives. A refusal passes on only as one of the closed
codes below; anything else is a Team that is unavailable. A saved or forgotten Sign-in changes the Team's
`sign-ins` topic.

A sign-in session belongs to the Supervisor session that started it: when that session ends (logout, revocation, or
expiry), Admin cancels it under the authority it was started with, so a Save under way keeps nothing.
"""

import asyncio
import contextlib
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from session import topics
from signin import auth
from team import transport

from chat import payloads
from protocol.http.v1 import sign_in as contract

log = logging.getLogger("shimpz-admin")

TOPIC = "sign-ins"
# How often the authorities of running sign-in sessions are checked again by the full rule, which also catches an
# absolute expiry no session listener announces.
SWEEP_SECONDS = 30


@dataclass(slots=True)
class _Tracked:
    """A Team's sign-in session as Admin started it: the authority it was started under, from before its start."""

    authority: Any
    # Known once Team answered the start; until then a revocation is remembered and acted on as the answer arrives.
    session_id: str | None = None
    revoked: bool = False


# Each Team's sign-in session, by Team: a Team runs at most one.
_TRACKED: dict[str, _Tracked] = {}
_GUARD = threading.Lock()
_SWEEP: list[asyncio.Task | None] = [None]
# The closed refusals: the URL or label is not admissible, the session or Team is gone, more than one window is open,
# the profile holds an identity provider's session, the Space's Browser is busy, or nothing could be saved or read.
_REFUSALS = {
    400: frozenset({contract.URL_INVALID, contract.LABEL_INVALID}),
    404: frozenset({contract.NOT_RUNNING, "team-not-found"}),
    409: frozenset({contract.WINDOWS, contract.IDENTITY_PROVIDER, "browser-busy"}),
    503: frozenset({contract.UNSAVED, "browser-unavailable", "sign-ins-unavailable"}),
}


def _admitted(body: object, admit: Callable[[object], dict[str, object] | None]) -> dict[str, object]:
    canonical = admit(body)
    if canonical is None:
        raise transport.TeamRequestError("the sign-in request is not admissible")
    return canonical


def _answer(
    response: transport.TeamResponse, admit: Callable[[object], dict[str, object] | None]
) -> transport.TeamResponse:
    """Team's exact traced answer as the page's untraced one, its closed refusal, or a Team that is unavailable."""
    body = response.body
    if response.status == 200 and "trace_id" in body:
        answer = admit({key: value for key, value in body.items() if key != "trace_id"})
        if answer is not None and transport.is_closed_traced(body, set(answer)):
            return transport.TeamResponse(200, answer)
    code = body.get("code")
    if response.status in _REFUSALS and code in _REFUSALS[response.status]:
        return transport.TeamResponse(response.status, {"detail": "sign-in unavailable", "code": code})
    return transport.TeamResponse(502, {"detail": "team unavailable"})


def _path(team_id: object, operation: str) -> str:
    return f"/v1/teams/{payloads.canonical_team_id(team_id)}/browser/{operation}"


def start(team_id: object, body: object) -> transport.TeamResponse:
    """Start a sign-in session: its id, the view its Browser is driven through, and its site."""
    admitted = _admitted(body, contract.canonical_start)
    return _answer(transport.call("POST", _path(team_id, "sign-in"), admitted), contract.canonical_started)


def _changed(team_id: object, response: transport.TeamResponse) -> transport.TeamResponse:
    if response.status == 200:
        topics.team_changed(payloads.canonical_team_id(team_id), TOPIC)
    return response


def save(team_id: object, body: object) -> transport.TeamResponse:
    """Save the session as a Sign-in under the person's label; once saving starts, the session ends however it goes."""
    admitted = _admitted(body, contract.canonical_save)
    response = transport.call("POST", _path(team_id, "sign-in/save"), admitted)
    return _changed(team_id, _answer(response, contract.canonical_sign_in))


def cancel(team_id: object, body: object) -> transport.TeamResponse:
    """End the session without keeping anything."""
    admitted = _admitted(body, contract.canonical_session)
    return _answer(transport.call("POST", _path(team_id, "sign-in/cancel"), admitted), contract.canonical_cancelled)


def listing(team_id: object) -> transport.TeamResponse:
    return _answer(transport.call("GET", _path(team_id, "sign-ins")), contract.canonical_sign_ins)


def forget(team_id: object, body: object) -> transport.TeamResponse:
    """Forget one Sign-in, deleting its sealed profile; `forgotten` is false when it was already gone."""
    admitted = _admitted(body, contract.canonical_forget)
    response = transport.call("POST", _path(team_id, "sign-ins/forget"), admitted)
    return _changed(team_id, _answer(response, contract.canonical_forgotten))


def start_under(authority: Any, team_id: object, body: object) -> transport.TeamResponse:
    """Start a sign-in session that belongs to `authority`, tracked before Team is asked.

    A revocation that comes while its Browser starts still cancels it once Team answers; this runs on a lane worker,
    so it completes whatever happens to the socket meanwhile.
    """
    canonical_id = payloads.canonical_team_id(team_id)
    tracked = _Tracked(authority)
    with _GUARD:
        _TRACKED[canonical_id] = tracked
    response = None
    try:
        response = start(canonical_id, body)
    finally:
        with _GUARD:
            running = response is not None and response.status == 200 and _TRACKED.get(canonical_id) is tracked
            if running:
                tracked.session_id = str(response.body["sign_in_session_id"])
                revoked = tracked.revoked
            if (not running or revoked) and _TRACKED.get(canonical_id) is tracked:
                del _TRACKED[canonical_id]
    if running and revoked:
        _cancel_apart(canonical_id, tracked)
    return response


def finished(team_id: str, session_id: object) -> None:
    """That sign-in session was saved or cancelled: its authority's end has nothing left to cancel."""
    with _GUARD:
        tracked = _TRACKED.get(team_id)
        if tracked is not None and tracked.session_id == session_id:
            del _TRACKED[team_id]


def _revoke(ended: Callable[[_Tracked], bool]) -> None:
    """Cancel every tracked session whose authority `ended`; one still starting is cancelled once Team answers."""
    with _GUARD:
        revoked = []
        for team_id, tracked in tuple(_TRACKED.items()):
            if not ended(tracked):
                continue
            if tracked.session_id is None:
                tracked.revoked = True
            else:
                del _TRACKED[team_id]
                revoked.append((team_id, tracked))
    for team_id, tracked in revoked:
        _cancel_apart(team_id, tracked)


def sessions_ended(sessions: frozenset[str] | None) -> None:
    """Supervisor sessions stopped being tracked (any thread): cancel every sign-in session one of them started."""
    _revoke(lambda tracked: sessions is None or tracked.authority.session in sessions)


def _cancel_apart(team_id: str, tracked: _Tracked) -> None:
    threading.Thread(target=_cancel_ended, args=(team_id, tracked), name="sign-in-revoked", daemon=True).start()


def _cancel_ended(team_id: str, tracked: _Tracked) -> None:
    with contextlib.suppress(transport.TeamRequestError), tracked.authority.scope():
        response = cancel(team_id, {"sign_in_session_id": tracked.session_id})
        if response.status not in {200, 404}:
            log.warning("a revoked session's sign-in could not be cancelled")


def sweep() -> None:
    """On the event loop: check every tracked authority again by the full rule while any session is tracked."""
    task = _SWEEP[0]
    if task is None or task.done():
        _SWEEP[0] = asyncio.get_running_loop().create_task(_sweep())


async def _sweep() -> None:
    while _TRACKED:
        await asyncio.sleep(SWEEP_SECONDS)
        with _GUARD:
            tracked = list(_TRACKED.values())
        lapsed = set()
        for item in tracked:
            if not await item.authority.current():
                lapsed.add(id(item))
        _revoke(lambda item, lapsed=frozenset(lapsed): id(item) in lapsed)


auth.SESSIONS.listen(sessions_ended)
