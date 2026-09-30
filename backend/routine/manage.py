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

_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
_TRACE_ID_RE = _ID_RE
_HEX64_RE = re.compile(r"[0-9a-f]{64}\Z")
_ERROR_CODE_RE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_INVALID = team.TeamResponse(HTTPStatus.BAD_GATEWAY, {"code": "routine-response-invalid"})


def _id(value: object, name: str) -> str:
    if not isinstance(value, str) or _ID_RE.fullmatch(value) is None:
        raise team.TeamRequestError(f"{name} is invalid")
    return value


def _timezone(body: object, fields: set[str]) -> dict[str, object]:
    if (
        not isinstance(body, dict)
        or set(body) != fields
        or routine_contract.canonical_timezone(body["timezone"]) is None
    ):
        raise team.TeamRequestError("Routine request is invalid")
    return body


def _projected(
    response: team.TeamResponse, admit: Callable[[dict[str, object]], dict[str, object] | None]
) -> team.TeamResponse:
    """Team's answer in its closed view, or an error that carries only a safe code."""
    body = dict(response.body) if isinstance(response.body, dict) else {}
    if not 200 <= response.status < 300:
        code = body.get("code")
        status = response.status if 400 <= response.status <= 599 else HTTPStatus.BAD_GATEWAY
        safe = isinstance(code, str) and _ERROR_CODE_RE.fullmatch(code) is not None
        return team.TeamResponse(status, {"code": code if safe else "routine-request-failed"})
    trace_id = body.pop("trace_id", None)
    if not isinstance(trace_id, str) or _TRACE_ID_RE.fullmatch(trace_id) is None:
        return _INVALID
    admitted = admit(body)
    return _INVALID if admitted is None else team.TeamResponse(response.status, admitted)


def _exact(fields: dict[str, Callable[[object], bool]]) -> Callable[[dict[str, object]], dict[str, object] | None]:
    def admit(body: dict[str, object]) -> dict[str, object] | None:
        return body if set(body) == set(fields) and all(check(body[name]) for name, check in fields.items()) else None

    return admit


def preview(team_id: object, proposal_id: object, body: object) -> team.TeamResponse:
    """The confirmation card's live facts; a proposal that expired or was used is gone."""
    canonical = team.canonical_team_id(team_id)
    proposal = _id(proposal_id, "Routine proposal")
    path = f"/v1/teams/{canonical}/routines/proposals/{proposal}/preview"
    response = transport._call("POST", path, _timezone(body, {"timezone"}))

    def admit(value: dict[str, object]) -> dict[str, object] | None:
        # The card confirms exactly the proposal it previewed.
        preview = routine_contract.canonical_preview(value)
        return preview if preview is not None and preview["proposal_id"] == proposal else None

    return _projected(response, admit)


def confirm(team_id: object, body: object) -> team.TeamResponse:
    """The Supervisor's confirmation: the only way a Routine is created or a cancellation is carried out."""
    canonical = team.canonical_team_id(team_id)
    body = _timezone(body, {"proposal_id", "timezone"})
    _id(body["proposal_id"], "Routine proposal")
    response = transport._call("POST", f"/v1/teams/{canonical}/routines", body)

    def admit(value: dict[str, object]) -> dict[str, object] | None:
        if set(value) == {"team_id", "routine"} and value["team_id"] == canonical:
            return value if routine_contract.canonical_routine_view(value["routine"]) is not None else None
        # Confirming a cancel card deletes the Routine its proposal named.
        return _deleted(canonical, None)(value)

    return _projected(response, admit)


def _deleted(team_id: str, routine_id: str | None) -> Callable[[dict[str, object]], dict[str, object] | None]:
    return _exact(
        {
            "team_id": lambda value: value == team_id,
            "routine_id": lambda value: (
                isinstance(value, str) and _ID_RE.fullmatch(value) is not None and routine_id in (None, value)
            ),
            "deleted": lambda value: type(value) is bool,
        }
    )


def list_routines(team_id: object) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    response = transport._call("GET", f"/v1/teams/{canonical}/routines")

    def items(admit: Callable[[object], object]) -> Callable[[object], bool]:
        return lambda value: (
            isinstance(value, list)
            and len(value) <= routine_contract.MAX_ROUTINES
            and all(admit(item) is not None for item in value)
        )

    fields = {
        "team_id": lambda value: value == canonical,
        "routines": items(routine_contract.canonical_routine_view),
        "runs": items(routine_contract.canonical_run_view),
    }
    return _projected(response, _exact(fields))


def delete(team_id: object, routine_id: object) -> team.TeamResponse:
    canonical = team.canonical_team_id(team_id)
    routine = _id(routine_id, "Routine")
    response = transport._call("DELETE", f"/v1/teams/{canonical}/routines/{routine}")
    return _projected(response, _deleted(canonical, routine))


def _run_decision(team_id: object, run_id: object, action: str, body: dict[str, object], result: str):
    canonical = team.canonical_team_id(team_id)
    run = _id(run_id, "Routine run")
    response = transport._call("POST", f"/v1/teams/{canonical}/routines/runs/{run}/{action}", body)
    fields = {
        "team_id": lambda value: value == canonical,
        "run_id": lambda value: value == run,
        result: lambda value: type(value) is bool,
    }
    return _projected(response, _exact(fields))


def stop(team_id: object, run_id: object) -> team.TeamResponse:
    """Stop exactly one run."""
    return _run_decision(team_id, run_id, "stop", {}, "stopped")


def resolve(team_id: object, run_id: object, body: object) -> team.TeamResponse:
    """A Supervisor's informed resolution of an uncertain run's exact batch."""
    fingerprint = (
        body.get("batch_fingerprint") if isinstance(body, dict) and set(body) == {"batch_fingerprint"} else None
    )
    if not isinstance(fingerprint, str) or _HEX64_RE.fullmatch(fingerprint) is None:
        raise team.TeamRequestError("Routine resolution is invalid")
    return _run_decision(team_id, run_id, "resolve", {"batch_fingerprint": fingerprint}, "resolved")
