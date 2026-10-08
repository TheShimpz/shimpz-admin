"""A Local Supervisor's Routine management through Team (ADR-0086).

Each call runs under the Supervisor's session assertion. Admin admits Team's answer only in its canonical protocol
view; any other body becomes one safe error, so the browser never renders an unchecked Routine.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from http import HTTPStatus

from team import bridge as team
from team import transport

from protocol.http.v1 import routine as routine_contract
from protocol.http.v1 import routine_notice as routine_notice_contract
from protocol.http.v1 import routine_proposal as routine_proposal_contract
from protocol.http.v1 import routine_run as routine_run_contract

_INVALID = team.TeamResponse(HTTPStatus.BAD_GATEWAY, {"code": "routine-response-invalid"})
# A path count in its one canonical decimal form, as Team reads it.
_COUNT_RE = re.compile(r"(?:0|[1-9][0-9]{0,9})\Z")


def _id(value: object, name: str) -> str:
    if not isinstance(value, str) or routine_contract.ROUTINE_ID_RE.fullmatch(value) is None:
        raise team.TeamRequestError(f"{name} is invalid")
    return value


def _count(value: object, name: str, minimum: int, bound: int) -> int:
    """A path count in its canonical decimal form, from ``minimum`` and below ``bound``."""
    if not isinstance(value, str) or _COUNT_RE.fullmatch(value) is None or not minimum <= int(value) < bound:
        raise team.TeamRequestError(f"{name} is invalid")
    return int(value)


def _projected(
    response: team.TeamResponse, admit: Callable[[dict[str, object]], dict[str, object] | None]
) -> team.TeamResponse:
    """Team's answer in its closed view, or an error that carries only a safe code."""
    body = dict(response.body) if isinstance(response.body, dict) else {}
    if not 200 <= response.status < 300:
        code = body.get("code")
        status = response.status if 400 <= response.status <= 599 else HTTPStatus.BAD_GATEWAY
        safe = isinstance(code, str) and routine_contract.ERROR_CODE_RE.fullmatch(code) is not None
        return team.TeamResponse(status, {"code": code if safe else "routine-request-failed"})
    trace_id = body.pop("trace_id", None)
    if not transport.is_trace_id(trace_id):
        return _INVALID
    admitted = admit(body)
    return _INVALID if admitted is None else team.TeamResponse(response.status, admitted)


def _exact(fields: dict[str, Callable[[object], bool]]) -> Callable[[dict[str, object]], dict[str, object] | None]:
    def admit(body: dict[str, object]) -> dict[str, object] | None:
        return body if set(body) == set(fields) and all(check(body[name]) for name, check in fields.items()) else None

    return admit


def _deleted(team_id: str, routine_id: str) -> Callable[[dict[str, object]], dict[str, object] | None]:
    return _exact(
        {
            "team_id": lambda value: value == team_id,
            "routine_id": lambda value: value == routine_id,
            "deleted": lambda value: type(value) is bool,
        }
    )


def list_routines(team_id: object) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    # The whole list is read within its own protocol bound, the one Team answer above the Local API's 128 KiB cap.
    response = transport._call(
        "GET", f"/v1/teams/{canonical}/routines", max_response_bytes=routine_notice_contract.MAX_ROUTINE_LIST_BYTES
    )

    def items(admit: Callable[[object], object], bound: int) -> Callable[[object], bool]:
        return lambda value: (
            isinstance(value, list) and len(value) <= bound and all(admit(item) is not None for item in value)
        )

    fields = {
        "team_id": lambda value: value == canonical,
        "routines": items(routine_notice_contract.canonical_routine_view, routine_contract.MAX_ROUTINES),
        "runs": items(routine_notice_contract.canonical_run_view, routine_contract.MAX_ROUTINES),
        # Held runs' incidents, which outlive a deleted Routine, each settled through its recovery card (ADR-0092).
        "incidents": items(
            routine_notice_contract.canonical_incident_view, routine_notice_contract.MAX_UNRESOLVED_INCIDENTS
        ),
    }
    return _projected(response, _exact(fields))


def deletion_subject(team_id: object, routine_id: object) -> str:
    """The one exact operation a Supervisor confirms before Admin asks Team to delete this Routine (ADR-0051)."""
    return f"routine-delete:{team.canonical_team_id(team_id)}:{_id(routine_id, 'Routine')}"


def delete(team_id: object, routine_id: object) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    routine = _id(routine_id, "Routine")
    response = transport._call("DELETE", f"/v1/teams/{canonical}/routines/{routine}")
    return _projected(response, _deleted(canonical, routine))


def _bound(admit: Callable[[object], dict[str, object] | None], **expected: object):
    """A view admitted only when it names exactly the identities it was asked for."""

    def bound(body: dict[str, object]) -> dict[str, object] | None:
        admitted = admit(body)
        if admitted is None or tuple(admitted[name] for name in expected) != tuple(expected.values()):
            return None
        return admitted

    return bound


def open_card(team_id: object, incident_id: object) -> team.TeamResponse:
    """Open a held run's recovery card for the authenticated person (ADR-0092 section 7)."""
    canonical = team.canonical_team_id(team_id)
    incident = _id(incident_id, "Routine incident")
    response = transport._call("POST", f"/v1/teams/{canonical}/routines/incidents/{incident}/card", {})
    return _projected(response, _bound(routine_run_contract.canonical_card, team_id=canonical, incident_id=incident))


def answer_card(team_id: object, incident_id: object, body: object) -> team.TeamResponse:
    """Answer one open recovery card once with Rodar; Excluir is the Routine's confirmed deletion.

    Rodar runs no model, so it carries no model credential.
    """
    canonical = team.canonical_team_id(team_id)
    incident = _id(incident_id, "Routine incident")
    answer = routine_run_contract.canonical_card_answer_request(body)
    if answer is None:
        raise team.TeamRequestError("Routine card answer is invalid")
    response = transport._call("POST", f"/v1/teams/{canonical}/routines/incidents/{incident}/answer", answer)
    admit = _bound(routine_run_contract.canonical_card_answer, team_id=canonical, incident_id=incident)
    return _projected(response, admit)


def _proposal(team_id: object, proposal_id: object, method: str, statuses: frozenset[str]) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    proposal = _id(proposal_id, "Routine proposal")
    # Confirm sends an empty object; revoke, like a deletion, sends no body.
    body = {} if method == "POST" else None
    response = transport._call(method, f"/v1/teams/{canonical}/routines/proposals/{proposal}", body)

    bound = _bound(routine_proposal_contract.canonical_proposal_answer, team_id=canonical, proposal_id=proposal)

    def admit(body: dict[str, object]) -> dict[str, object] | None:
        admitted = bound(body)
        return admitted if admitted is not None and admitted["status"] in statuses else None

    return _projected(response, admit)


def confirm_proposal(team_id: object, proposal_id: object) -> team.TeamResponse:
    """Criar rotina: the person's one tap that creates or changes the Routine its card shows (ADR-0101 section 5.3)."""
    return _proposal(team_id, proposal_id, "POST", frozenset({"created", "changed"}))


def revoke_proposal(team_id: object, proposal_id: object) -> team.TeamResponse:
    """Cancelar: revoke the card, so nothing it shows can ever be created; an absent card is already revoked."""
    return _proposal(team_id, proposal_id, "DELETE", frozenset({"revoked"}))


def diagnostics(team_id: object, run_id: object) -> team.TeamResponse:
    """One run's execution details (ADR-0092): Team's sanitized diagnostics, which the browser renders only as text."""
    canonical = team.canonical_team_id(team_id)
    run = _id(run_id, "Routine run")
    response = transport._call("GET", f"/v1/teams/{canonical}/routines/runs/{run}/diagnostics")
    return _projected(response, _bound(routine_run_contract.canonical_diagnostics, team_id=canonical, run_id=run))


def plan_steps(team_id: object, routine_id: object, revision: object, offset: object) -> team.TeamResponse:
    """One page of a Routine revision's steps from ``offset``, admitted only for exactly the page asked for.

    Team refuses a revision that is no longer current, so the browser never combines two revisions' steps.
    """
    canonical = team.canonical_team_id(team_id)
    routine = _id(routine_id, "Routine")
    number = _count(revision, "Routine revision", 1, 2**31)
    start = _count(offset, "Routine step offset", 0, routine_contract.MAX_ROUTINE_STEPS)
    response = transport._call("GET", f"/v1/teams/{canonical}/routines/{routine}/revisions/{number}/steps/{start}")
    admit = _bound(routine_contract.canonical_page, routine_id=routine, revision=number, offset=start)
    return _projected(response, admit)


def run_steps(team_id: object, run_id: object, snapshot: object, offset: object) -> team.TeamResponse:
    """One page of what a run did step by step, from ``offset``, of one snapshot of its records.

    ``latest`` asks for the current snapshot, which the page then names; any other page is admitted only for exactly
    the snapshot asked for, and Team refuses one whose records changed since.
    """
    canonical = team.canonical_team_id(team_id)
    run = _id(run_id, "Routine run")
    if snapshot != "latest" and (
        not isinstance(snapshot, str) or routine_run_contract.SNAPSHOT_RE.fullmatch(snapshot) is None
    ):
        raise team.TeamRequestError("Routine run snapshot is invalid")
    # A run's page lists its replay steps.
    start = _count(offset, "Routine step offset", 0, routine_contract.MAX_ROUTINE_STEPS)
    response = transport._call("GET", f"/v1/teams/{canonical}/routines/runs/{run}/steps/{snapshot}/{start}")

    bound = _bound(routine_run_contract.canonical_run_steps, team_id=canonical, run_id=run, offset=start)

    def admit(body: dict[str, object]) -> dict[str, object] | None:
        page = bound(body)
        return page if page is not None and snapshot in ("latest", page["snapshot"]) else None

    return _projected(response, admit)


def _set_paused(team_id: object, routine_id: object, paused: bool) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    routine = _id(routine_id, "Routine")
    action = "pause" if paused else "resume"
    response = transport._call("POST", f"/v1/teams/{canonical}/routines/{routine}/{action}", {})
    fields = {
        "team_id": lambda value: value == canonical,
        "routine_id": lambda value: value == routine,
        "paused": lambda value: value is paused,
    }
    return _projected(response, _exact(fields))


def resume(team_id: object, routine_id: object) -> team.TeamResponse:
    """Turn a paused Routine's dispatch back on; an unresolved incident still holds it."""
    return _set_paused(team_id, routine_id, False)


def pause(team_id: object, routine_id: object) -> team.TeamResponse:
    """Turn a Routine's dispatch off until it is resumed; a run already going finishes."""
    return _set_paused(team_id, routine_id, True)
