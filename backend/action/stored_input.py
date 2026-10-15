"""Metadata-only Admin bridge for Team-owned persistent Action inputs."""

import logging

from session import topics
from team import transport

from chat import payloads

MAX_STORED_INPUTS = 128
STATUSES = frozenset({"missing", "stored"})

log = logging.getLogger("shimpz-admin")


def _project_inventory(response: transport.TeamResponse, team_id: str) -> transport.TeamResponse:
    if not 200 <= response.status < 300:
        return response
    try:
        if not transport.is_closed_traced(response.body, {"team_id", "stored_inputs"}, team_id=team_id):
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
            stored_input_id = payloads.canonical_identifier(item["stored_input_id"])
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
    except KeyError, TypeError, ValueError, transport.TeamRequestError:
        log.warning("team returned an invalid Stored Input inventory")
        return transport.TeamResponse(502, {"detail": "Assistant Stored Input inventory is invalid."})
    return transport.TeamResponse(200, {"stored_inputs": inventory})


def list_assistant_stored_inputs(team_id: object) -> transport.TeamResponse:
    canonical = payloads.canonical_team_id(team_id)
    return _project_inventory(
        transport.call("GET", f"/v1/teams/{canonical}/assistant-stored-inputs"),
        canonical,
    )


def clear_assistant_stored_input(
    team_id: object,
    assistant_id: object,
    stored_input_id: object,
) -> transport.TeamResponse:
    canonical = payloads.canonical_team_id(team_id)
    assistant = payloads.canonical_assistant_id(assistant_id)
    stored_input = payloads.canonical_identifier(stored_input_id)
    response = transport.call(
        "DELETE",
        f"/v1/teams/{canonical}/assistant-stored-inputs/{assistant}/{stored_input}",
    )
    if not 200 <= response.status < 300:
        return response
    if (
        response.status != 200
        or not transport.is_closed_traced(
            response.body, {"team_id", "assistant_id", "stored_input_id", "cleared"}, team_id=canonical
        )
        or response.body["assistant_id"] != assistant
        or response.body["stored_input_id"] != stored_input
        or type(response.body["cleared"]) is not bool
    ):
        log.warning("team returned an invalid Stored Input clear response")
        return transport.TeamResponse(502, {"detail": "Assistant Stored Input clear response is invalid."})
    topics.team_changed(canonical, "integrations")
    return transport.TeamResponse(200, {"cleared": response.body["cleared"]})
