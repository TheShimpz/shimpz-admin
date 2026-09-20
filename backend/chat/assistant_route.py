"""One structured preparation path for every fresh Local chat objective."""

from __future__ import annotations

import profile as admin_profile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from chat.executor import submit_in_context
from team import bridge as team

from chat import assistant_inventory, assistant_plan, assistant_proposal, assistant_uninstall, local, store_catalog

Intent = Literal["ordinary-task", "assistant-install", "assistant-uninstall", "unresolved"]
Guidance = Literal[
    "assistant-install-target-required",
    "assistant-uninstall-target-required",
    "assistant-lifecycle-ambiguous",
]


@dataclass(frozen=True, slots=True)
class Result:
    intent: Intent
    preparation: assistant_plan.Preparation | None = None
    uninstall: assistant_proposal.UninstallCandidate | None = None
    guidance: Guidance | None = None
    error_status: int | None = None


class RouteError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__("structured Assistant routing failed")
        self.status = status


def _safe_status(response: object) -> int:
    return response.status if isinstance(response, team.TeamResponse) and 400 <= response.status <= 599 else 502


def _route(
    team_id: str,
    objective: object,
    expected_intent: str | None,
    candidates: list[dict[str, object]],
) -> tuple[Intent, str, tuple[str, ...]]:
    response = local.intent_route(team_id, objective, expected_intent, candidates)
    if not isinstance(response, team.TeamResponse) or not 200 <= response.status < 300:
        raise RouteError(_safe_status(response))
    body = response.body
    if not isinstance(body, dict) or set(body) != {"team_id", "intent", "query", "assistant_ids"}:
        raise RouteError(502)
    intent = body["intent"]
    query = body["query"]
    assistant_ids = body["assistant_ids"]
    if (
        body["team_id"] != team_id
        or intent not in {"ordinary-task", "assistant-install", "assistant-uninstall", "unresolved"}
        or not isinstance(query, str)
        or not isinstance(assistant_ids, list)
        or any(not isinstance(value, str) for value in assistant_ids)
    ):
        raise RouteError(502)
    return intent, query, tuple(assistant_ids)


def _directory_candidate(assistant: assistant_proposal.DirectoryAssistant) -> dict[str, object]:
    return {"id": assistant.assistant_id, "name": assistant.name, "summary": assistant.summary}


def _uninstall_candidate(candidate: assistant_proposal.UninstallCandidate) -> dict[str, object]:
    return {"id": candidate.assistant.assistant_id, "name": candidate.assistant.name, "summary": ""}


def _catalog_state(
    team_id: str,
    catalog: store_catalog.StoreCatalog,
    include_local: bool,
) -> tuple[
    dict[str, assistant_inventory.InstalledAssistant],
    tuple[assistant_proposal.DirectoryAssistant, ...],
]:
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-route-directory") as executor:
        inventory_future = submit_in_context(executor, assistant_plan.team_inventory, team_id)
        catalog_future = submit_in_context(executor, assistant_plan.planning_catalog, catalog, include_local)
        installed, _registry = inventory_future.result()
        available = catalog_future.result()
    return installed, available


def _prepare_install(
    team_id: str,
    payload: dict[str, object],
    query: str,
    catalog: store_catalog.StoreCatalog,
    include_local: bool,
) -> Result:
    if not query:
        return Result("assistant-install", guidance="assistant-install-target-required")
    installed, available = _catalog_state(team_id, catalog, include_local)
    shortlist = assistant_proposal.install_shortlist(query, available)
    if not shortlist:
        return Result("assistant-install", guidance="assistant-install-target-required")
    intent, _query, selected = _route(
        team_id,
        payload["message"],
        "assistant-install",
        [_directory_candidate(assistant) for assistant in shortlist],
    )
    if intent == "unresolved":
        return Result("assistant-install", guidance="assistant-install-target-required")
    preparation = assistant_plan.prepare_install(team_id, payload, selected, installed, available)
    return Result("assistant-install", preparation=preparation)


def _prepare_uninstall(team_id: str, payload: dict[str, object], query: str) -> Result:
    if not query:
        return Result("assistant-uninstall", guidance="assistant-uninstall-target-required")
    shortlist = assistant_proposal.uninstall_shortlist(query, assistant_uninstall.candidates(team_id))
    if not shortlist:
        return Result("assistant-uninstall", guidance="assistant-uninstall-target-required")
    intent, _query, selected = _route(
        team_id,
        payload["message"],
        "assistant-uninstall",
        [_uninstall_candidate(candidate) for candidate in shortlist],
    )
    if intent == "unresolved":
        return Result("assistant-uninstall", guidance="assistant-uninstall-target-required")
    matches = tuple(candidate for candidate in shortlist if candidate.assistant.assistant_id in selected)
    if len(matches) != 1:
        raise RouteError(502)
    return Result("assistant-uninstall", uninstall=matches[0])


def _prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
    *,
    allow_uninstall: bool,
) -> Result:
    """Classify once, then lazily open only the required bounded directory."""
    intent, query, _selected = _route(team_id, payload["message"], None, [])
    if intent == "ordinary-task":
        preparation = assistant_plan.prepare_capability(
            team_id,
            payload,
            catalog,
            admin_profile.require() == "local" if include_local is None else include_local,
        )
        return Result(intent, preparation=preparation)
    if payload["files"]:
        return Result("unresolved", error_status=422)
    if intent == "unresolved":
        return Result("unresolved", guidance="assistant-lifecycle-ambiguous")
    local_enabled = admin_profile.require() == "local" if include_local is None else include_local
    if intent == "assistant-install":
        return _prepare_install(team_id, payload, query, catalog, local_enabled)
    if not allow_uninstall:
        return Result("unresolved", error_status=422)
    return _prepare_uninstall(team_id, payload, query)


def prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
) -> Result:
    """Classify a fresh chat turn and open only its required bounded directory."""
    return _prepare(team_id, payload, catalog, include_local, allow_uninstall=True)


def prepare_resume(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
) -> Result:
    """Reclassify a reconnect objective without admitting destructive lifecycle work."""
    return _prepare(team_id, payload, catalog, include_local, allow_uninstall=False)
