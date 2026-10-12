"""Staged Assistant snapshots as session calls: inventory, localized summary, and page (ADR-0091).

Each snapshot is named by its exact image id; its icon stays an HTTP image (`team/assets.py`).
"""

from fastapi.responses import JSONResponse
from team import bridge as team
from team import http as team_http
from team import summary as team_summary


def local_assistants_list() -> JSONResponse:
    return team_http.response(team.list_local_assistants)


def local_assistant_summary(image_id: str, locale: str) -> JSONResponse:
    """One staged snapshot's summary in the interface language, from its own pack; a busy preview keeps its hint."""
    return team_summary.localized(
        lambda canonical: team.local_assistant_summary(image_id, canonical), locale, "Local Assistant"
    )


def local_assistant_details(image_id: str, locale: str) -> JSONResponse:
    """One staged snapshot's page in the interface language, from the exact image's package and own pack."""
    return team_summary.localized(
        lambda canonical: team.local_assistant_details(image_id, canonical), locale, "Local Assistant", kind="details"
    )
