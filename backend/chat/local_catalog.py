"""Strict bounded planning projection for locally staged Assistant snapshots."""

from dataclasses import dataclass
from datetime import datetime

from team import bridge as team

from chat import store_catalog
from protocol.http.v1 import payload as team_contract

MAX_ASSISTANTS = team_contract.MAX_LOCAL_ASSISTANTS


@dataclass(frozen=True, slots=True)
class LocalAssistant:
    assistant_id: str
    name: str
    summary: str
    image_id: str
    integrations: tuple[store_catalog.CatalogIntegration, ...]
    actions: tuple[str, ...]
    assistant_version: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class LocalInventory:
    """The staged Local snapshots a plan may offer, and every Assistant identity staged in this Space.

    A staged identity Team did not admit is never offered, yet it still shadows a publication of the same Assistant,
    so a broken or unanswered staged snapshot never silently becomes its public publication (ADR-0060).
    """

    offerable: tuple[LocalAssistant, ...]
    staged_ids: frozenset[str]


def _created_at(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Local Assistant creation time is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Local Assistant creation time is invalid")
    return parsed


def _assistant(value: object) -> tuple[LocalAssistant, bool]:
    """One staged snapshot as Team's protocol admits it, and whether Team's verdict lets a plan offer it."""
    entry = team_contract.canonical_local_assistant(value)
    if entry is None:
        raise ValueError("Local Assistant inventory entry is invalid")
    assistant = LocalAssistant(
        assistant_id=str(entry["assistant_id"]),
        name=store_catalog.catalog_text(entry["name"], 80),
        summary=store_catalog.catalog_text(entry["summary"], 80),
        image_id=str(entry["image_id"]),
        integrations=tuple(store_catalog.CatalogIntegration(provider, ()) for provider in entry["integrations"]),
        actions=tuple(entry["actions"]),
        assistant_version=str(entry["assistant_version"]),
        created_at=_created_at(str(entry["created_at"])),
    )
    return assistant, entry["admission"] == "admissible"


def primary(response: object) -> LocalInventory:
    """Return the newest exact staged image of every Local Assistant identity Team admitted, and every staged id."""
    if not team.is_team_response(response) or not 200 <= response.status < 300 or not isinstance(response.body, dict):
        raise ValueError("Local Assistant inventory is unavailable")
    allowed = team.trace_envelope(response.body, {"assistants"})
    raw = response.body.get("assistants")
    if set(response.body) != allowed or not isinstance(raw, list) or len(raw) > MAX_ASSISTANTS:
        raise ValueError("Local Assistant inventory is invalid")
    entries = tuple(_assistant(item) for item in raw)
    image_ids = tuple(assistant.image_id for assistant, _offerable in entries)
    if len(set(image_ids)) != len(image_ids):
        raise ValueError("Local Assistant inventory is invalid")
    newest: dict[str, tuple[LocalAssistant, bool]] = {}
    for assistant, offerable in entries:
        current = newest.get(assistant.assistant_id)
        if current is None or (assistant.created_at, assistant.image_id) > (
            current[0].created_at,
            current[0].image_id,
        ):
            newest[assistant.assistant_id] = (assistant, offerable)
    return LocalInventory(
        offerable=tuple(newest[assistant_id][0] for assistant_id in sorted(newest) if newest[assistant_id][1]),
        staged_ids=frozenset(newest),
    )


def localized_summary(assistant: LocalAssistant, locale: str) -> str:
    """One staged snapshot's summary in one interface language, read by Team from the snapshot's own pack (ADR-0091).

    The summary is only what Team returns for exactly that language, never the English summary in its place.
    """
    response = team.local_assistant_summary(assistant.image_id, locale)
    if not isinstance(response, team.TeamResponse) or response.status != 200 or not isinstance(response.body, dict):
        raise ValueError("Local Assistant summary is unavailable")
    body = {key: value for key, value in response.body.items() if key != "trace_id"}
    summary = team_contract.canonical_snapshot_summary(body)
    if summary is None or summary["locale"] != locale:
        raise ValueError("Local Assistant summary is invalid")
    return store_catalog.catalog_text(summary["summary"], 80)
