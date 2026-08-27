"""Metadata-only Admin bridge for Team-owned persistent Action inputs."""

from __future__ import annotations

import logging

from team import transport

from chat import payloads
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import websocket as team_http

TeamResponse = transport.TeamResponse
TeamRequestError = transport.TeamRequestError
MAX_STORED_INPUTS = 128
STATUSES = frozenset({"missing", "stored"})

log = logging.getLogger("shimpz-admin")


def _team_id(value: object) -> str:
    canonical = team_contract.canonical_team_id(value)
    if canonical is None:
        raise TeamRequestError("team id must be a canonical lowercase identifier")
    return canonical


def _trace(value: object) -> bool:
    return isinstance(value, str) and team_http.HEX_ID_RE.fullmatch(value) is not None


def _project_inventory(response: TeamResponse, team_id: str) -> TeamResponse:
    if not 200 <= response.status < 300:
        return response
    try:
        if (
            set(response.body) != {"team_id", "stored_inputs", "trace_id"}
            or response.body["team_id"] != team_id
            or not _trace(response.body["trace_id"])
        ):
            raise ValueError("invalid Stored Input envelope")
        raw = response.body["stored_inputs"]
        if not isinstance(raw, list) or len(raw) > MAX_STORED_INPUTS:
            raise ValueError("invalid Stored Input inventory")
        inventory: list[dict[str, str]] = []
        identities: set[tuple[str, str]] = set()
        for item in raw:
            if not isinstance(item, dict) or set(item) != {"assistant_id", "stored_input_id", "status"}:
                raise ValueError("invalid Stored Input metadata")
            assistant_id = payloads.canonical_assistant_id(item["assistant_id"])
            stored_input_id = payloads.canonical_assistant_id(item["stored_input_id"])
            identity = (assistant_id, stored_input_id)
            if identity in identities or item["status"] not in STATUSES:
                raise ValueError("invalid Stored Input metadata")
            identities.add(identity)
            inventory.append(
                {
                    "assistant_id": assistant_id,
                    "stored_input_id": stored_input_id,
                    "status": item["status"],
                }
            )
        if inventory != sorted(inventory, key=lambda item: (item["assistant_id"], item["stored_input_id"])):
            raise ValueError("unsorted Stored Input inventory")
    except KeyError, TypeError, ValueError, TeamRequestError:
        log.warning("team returned an invalid Stored Input inventory")
        return TeamResponse(502, {"detail": "Assistant Stored Input inventory is invalid."})
    return TeamResponse(200, {"stored_inputs": inventory})


def list_assistant_stored_inputs(team_id: object) -> TeamResponse:
    canonical = _team_id(team_id)
    return _project_inventory(
        transport._call("GET", f"/v1/teams/{canonical}/assistant-stored-inputs"),
        canonical,
    )


def clear_assistant_stored_input(
    team_id: object,
    assistant_id: object,
    stored_input_id: object,
) -> TeamResponse:
    canonical = _team_id(team_id)
    assistant = payloads.canonical_assistant_id(assistant_id)
    stored_input = payloads.canonical_assistant_id(stored_input_id)
    response = transport._call(
        "DELETE",
        f"/v1/teams/{canonical}/assistant-stored-inputs/{assistant}/{stored_input}",
    )
    if not 200 <= response.status < 300:
        return response
    if (
        response.status != 200
        or set(response.body) != {
            "team_id",
            "assistant_id",
            "stored_input_id",
            "cleared",
            "trace_id",
        }
        or response.body["team_id"] != canonical
        or response.body["assistant_id"] != assistant
        or response.body["stored_input_id"] != stored_input
        or type(response.body["cleared"]) is not bool
        or not _trace(response.body["trace_id"])
    ):
        log.warning("team returned an invalid Stored Input clear response")
        return TeamResponse(502, {"detail": "Assistant Stored Input clear response is invalid."})
    return TeamResponse(200, {"cleared": response.body["cleared"]})
