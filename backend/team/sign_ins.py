"""A Team's Sign-ins for the Supervisor (ADR-0117, Sign-ins amendment).

The Supervisor starts a sign-in session at one https site, drives its Browser through the view's control stream, and
Saves it as a Sign-in with a label of their own, or cancels it; they list the Team's Sign-ins and forget one. Every
body is checked against Team's protocol before Team is reached, and every answer of Team's is admitted only in its
exact form with its trace identifier, which the page never receives. A refusal passes on only as one of the closed
codes below; anything else is a Team that is unavailable. A saved or forgotten Sign-in changes the Team's
`sign-ins` topic.
"""

from collections.abc import Callable

from session import topics
from team import transport

from chat import payloads
from protocol.http.v1 import sign_in as contract

TOPIC = "sign-ins"
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
