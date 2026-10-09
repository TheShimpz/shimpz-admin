"""Local-only same-origin projection of staged Assistant snapshots: inventory, icon, localized summary, and page."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from team import assets as team_assets
from team import bridge as team
from team import http as team_http
from team import summary as team_summary


def register(app: FastAPI, profile: str) -> None:
    """Staged snapshots exist only in the Local profile; Hosted never exposes these routes."""
    if profile != "local":
        return
    app.add_api_route("/api/local-assistants", local_assistants_list, methods=["GET"])
    app.add_api_route("/api/local-assistants/{image_hash}/icon", team_assets.local_assistant_icon, methods=["GET"])
    app.add_api_route("/api/local-assistants/{image_hash}/summary", local_assistant_summary, methods=["GET"])
    app.add_api_route("/api/local-assistants/{image_hash}/details", local_assistant_details, methods=["GET"])


def local_assistants_list() -> JSONResponse:
    return team_http.response(team.list_local_assistants)


def local_assistant_summary(image_hash: str, locale: str = "") -> JSONResponse:
    """One staged snapshot's summary in the interface language, from its own pack (ADR-0091).

    A busy preview passes its retry hint through unchanged.
    """
    return team_summary.localized(
        lambda canonical: team.local_assistant_summary(f"sha256:{image_hash}", canonical),
        locale,
        "Local Assistant",
    )


def local_assistant_details(image_hash: str, locale: str = "") -> JSONResponse:
    """One staged snapshot's page in the interface language, from the exact image's package and own pack (ADR-0091).

    A busy preview passes its retry hint through unchanged.
    """
    return team_summary.localized(
        lambda canonical: team.local_assistant_details(f"sha256:{image_hash}", canonical),
        locale,
        "Local Assistant",
        kind="details",
    )
