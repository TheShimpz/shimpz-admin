"""Same-origin projection of one Assistant's summary or page in one interface language, read by Team from a pack."""

import json
from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http

from chat import assistant_inventory
from protocol.http.v1 import payload as team_contract


def register(app: FastAPI) -> None:
    """Register the interface registry and an installed Assistant's summary."""
    app.add_api_route("/api/assistants", assistants_list, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/assistants/{assistant_id}/summary", assistant_summary, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/assistants/{assistant_id}/details", assistant_details, methods=["GET"])


def assistants_list() -> JSONResponse:
    """The registry names the interface shows, without Team's canonical English summaries (ADR-0091).

    Team's registry summary is the English catalog text it plans with; the interface never shows it, so only each
    identity and name reach the browser.
    """
    return team_http.response(_interface_registry)


def _interface_registry() -> team.TeamResponse:
    response = team.list_assistants()
    if not 200 <= response.status < 300:
        return response
    try:
        registry = assistant_inventory.registry(response)
    except ValueError:
        raise HTTPException(status_code=502, detail="Team Assistant registry is invalid") from None
    return team.TeamResponse(
        200, {"assistants": [{"id": item.assistant_id, "title": item.name} for item in registry.values()]}
    )


def localized(
    read: Callable[[str], team.TeamResponse],
    locale: str,
    subject: str,
    *,
    kind: str = "summary",
) -> JSONResponse:
    """Answer exactly Team's summary or page in the requested locale, never another language.

    A Team failure keeps its bounded status, code, and any retry hint; an answer outside the closed shape or in another
    locale fails as invalid.
    """
    canonical = team_contract.canonical_locale(locale)
    if canonical is None:
        raise HTTPException(status_code=422, detail=f"Assistant {kind} locale is invalid")
    with team_http.refused_as_bad_request():
        result = read(canonical)
    if result.status != 200:
        return JSONResponse(status_code=result.status, content=result.body)
    body = {key: value for key, value in result.body.items() if key != "trace_id"}
    validate = (
        team_contract.canonical_snapshot_summary if kind == "summary" else team_contract.canonical_assistant_details
    )
    answer = validate(body)
    if answer is None or answer["locale"] != canonical:
        raise HTTPException(status_code=502, detail=f"{subject} {kind} is invalid")
    return JSONResponse(content=answer, headers={"Cache-Control": "no-store"})


def assistant_summary(team_id: str, assistant_id: str, locale: str = "") -> JSONResponse:
    """One installed Assistant's summary in the interface language, from its binding's own pack."""
    return localized(lambda canonical: team.assistant_summary(team_id, assistant_id, canonical), locale, "Assistant")


def assistant_details(team_id: str, assistant_id: str, locale: str = "") -> JSONResponse:
    """One installed Assistant's page in the interface language, from its exact binding and that binding's pack.

    Team answers for the binding it runs, so the identity it returns must be the one asked for.
    """
    response = localized(
        lambda canonical: team.assistant_details(team_id, assistant_id, canonical), locale, "Assistant", kind="details"
    )
    return _same_assistant(response, assistant_id)


def _same_assistant(response: JSONResponse, assistant_id: str) -> JSONResponse:
    if response.status_code == 200 and json.loads(response.body)["assistant_id"] != assistant_id:
        raise HTTPException(status_code=502, detail="Assistant details are invalid")
    return response
