"""Admin's machine calls to Team for Routines (ADR-0086): claim, run one leased segment, and deliver notices.

Claims and notices use only the Team bearer; a run segment is signed by Admin's routine identity for the run's own
lease. Every answer is admitted only in its canonical protocol view.
"""

from __future__ import annotations

import json
import re

import models
import supervisor
from team import bridge as team
from team import transport

from protocol.http.v1 import routine_notice as routine_notice_contract
from protocol.http.v1 import routine_run as routine_run_contract

# A segment's socket timeout: its run's claimed active time plus a fixed margin, never below fifteen minutes.
MIN_RUN_TIMEOUT_SECONDS = 15 * 60
RUN_TIMEOUT_MARGIN_SECONDS = 5 * 60
# A person's answer resumes a run whose active time Admin was never told, so it waits as long as any run may spend.
RESUME_TIMEOUT_SECONDS = routine_run_contract.MAX_ACTIVE_SECONDS + RUN_TIMEOUT_MARGIN_SECONDS
TRACE_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
# "held": a compiled run Team holds as an incident for recovery; "recovered": one its recovery completed (ADR-0092).
RUN_STATUSES = frozenset({"done", "recovered", "failed", "denied", "stopped", "frozen", "held"})
# Team admits at most this many deliveries in one notice acknowledgment.
MAX_ACK_DELIVERIES = 256


class RoutineTeamError(RuntimeError):
    """Team did not answer a Routine call in its closed form; the caller retries on its next tick."""


def _answer(response: team.TeamResponse) -> dict[str, object]:
    if response.status != 200 or not isinstance(response.body, dict):
        raise RoutineTeamError(f"Team answered {response.status}")
    body = dict(response.body)
    trace_id = body.pop("trace_id", None)
    if not isinstance(trace_id, str) or TRACE_ID_RE.fullmatch(trace_id) is None:
        raise RoutineTeamError("Team answer has no trace")
    return body


def claim(long: bool) -> dict[str, object]:
    """Lease at most one due run: ``run`` is None when nothing may start now, and ``next_due_at`` then hints when.

    ``long`` says whether Admin can take a long run now. A healthy compiled run needs no model key, so a claim is never
    gated on one (ADR-0092).
    """
    body = routine_run_contract.canonical_claim(_answer(transport._call("POST", "/v1/routines/claim", {"long": long})))
    if body is None:
        raise RoutineTeamError("Routine claim is invalid")
    return body


def is_long(claimed: dict[str, object]) -> bool:
    """Whether a claimed run may spend more active time than a short one (ADR-0092 amendment, 2026-10-05, scale)."""
    return claimed["active_seconds"] > routine_run_contract.SHORT_ACTIVE_SECONDS


def run_timeout(claimed: dict[str, object]) -> int:
    """The socket timeout of one segment of a claimed run, which Team bounds by the run's active time."""
    return max(MIN_RUN_TIMEOUT_SECONDS, claimed["active_seconds"] + RUN_TIMEOUT_MARGIN_SECONDS)


def run(claimed: dict[str, object], identity: supervisor.LocalIdentity) -> str:
    """Run one segment of a claimed run under its lease; returns how the run stands afterwards.

    The Team's model key travels only when Admin holds one: a compiled run needs none, and without it a recovery
    the run needs pauses as unavailable in Team instead of reasoning (ADR-0092).
    """
    team_id, run_id = claimed["team_id"], claimed["run_id"]
    api_key = models.resolve_api_key(claimed["provider"])
    response = transport._call_stream(
        "POST",
        f"/v1/teams/{team_id}/routines/runs/{run_id}/segment",
        # The signed segment names exactly the revision, plan, and mode its claim leased (ADR-0092).
        {"revision": claimed["revision"], "plan_digest": claimed["plan_digest"], "mode": claimed["mode"]},
        timeout=run_timeout(claimed),
        bindings=transport._RequestBindings(
            model_credential=(claimed["provider"], api_key) if api_key else None,
            routine=(identity, claimed["lease_token"]),
        ),
        progress=lambda _event: None,
    )
    body = _answer(response)
    if set(body) != {"team_id", "run_id", "status"} or (body["team_id"], body["run_id"]) != (team_id, run_id):
        raise RoutineTeamError("Routine run answer is invalid")
    if body["status"] not in RUN_STATUSES:
        raise RoutineTeamError("Routine run status is invalid")
    return body["status"]


def notices() -> dict[str, object]:
    """One bounded batch of every Team's undelivered notices."""
    batch = routine_notice_contract.canonical_notice_batch(_answer(transport._call("GET", "/v1/routines/notices")))
    if batch is None:
        raise RoutineTeamError("Routine notices are invalid")
    return batch


def _encoded_bytes(value: object) -> int:
    """The size of a value in the transport's request encoding."""
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def _acknowledgments(deliveries: list[dict[str, object]]) -> list[list[dict[str, object]]]:
    """Split deliveries so each acknowledgment fits both Team's delivery count and Admin's request body bound."""
    empty = _encoded_bytes({"deliveries": []})
    chunks: list[list[dict[str, object]]] = []
    chunk: list[dict[str, object]] = []
    size = empty
    for item in deliveries:
        cost = _encoded_bytes(item)
        if chunk and (len(chunk) == MAX_ACK_DELIVERIES or size + 1 + cost > transport.MAX_JSON_BODY_BYTES):
            chunks.append(chunk)
            chunk, size = [], empty
        size += cost + (1 if chunk else 0)
        chunk.append(item)
    if chunk:
        chunks.append(chunk)
    return chunks


def acknowledge(delivered: list[dict[str, object]]) -> None:
    """Admin wrote these exact notice versions to their transcripts.

    A batch may hold more deliveries than one acknowledgment admits, so it is acknowledged in bounded requests.
    Acknowledging is idempotent per version: a failure leaves only the unacknowledged rest pending, delivered again.
    """
    deliveries = [{name: item[name] for name in ("team_id", "notice_id", "version")} for item in delivered]
    for chunk in _acknowledgments(deliveries):
        answer = _answer(transport._call("POST", "/v1/routines/notices/ack", {"deliveries": chunk}))
        if answer != {"acknowledged": True}:
            raise RoutineTeamError("Routine acknowledgment is invalid")
