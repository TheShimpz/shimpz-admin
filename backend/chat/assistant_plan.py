"""Stateless gap planning and sequential fresh Assistant installation for one socket task."""

from __future__ import annotations

import secrets
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from chat.executor import submit_in_context
from team import bridge as team

from chat import assistant_install, assistant_inventory, assistant_proposal, local, store_catalog

MAX_PLAN_ASSISTANTS = 4
MAX_CHAT_ASSISTANTS = 16


@dataclass(frozen=True, slots=True)
class Plan:
    plan_id: str
    team_id: str
    assistants: tuple[store_catalog.CatalogAssistant, ...]
    dispatch_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Preparation:
    plan: Plan | None = None
    error_status: int | None = None


@dataclass(frozen=True, slots=True)
class Result:
    state: Literal["installed", "failed", "stopped"]
    assistants: tuple[dict[str, object], ...]
    status: int | None = None


def _planner_candidate(assistant: store_catalog.CatalogAssistant) -> dict[str, object]:
    return {
        "id": assistant.assistant_id,
        "name": assistant.name,
        "summary": assistant.summary,
        "actions": list(assistant.actions),
        "integrations": [
            {"id": integration.provider, "provider": integration.provider}
            for integration in assistant.integrations
        ],
    }


def _enabled_capabilities(
    team_id: str,
    enabled_ids: tuple[str, ...],
) -> tuple[dict[str, assistant_inventory.InstalledAssistant], tuple[assistant_proposal.Capability, ...]] | None:
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-inventory") as executor:
        installed_future = submit_in_context(executor, team.list_installed_assistants, team_id)
        registry_future = submit_in_context(executor, team.list_assistants)
        installed_response = installed_future.result()
        registry_response = registry_future.result()
    installed = assistant_inventory.installed(installed_response)
    registry = assistant_inventory.registry(registry_response)
    if any(
        assistant_id not in registry
        or assistant_id not in installed
        or installed[assistant_id].status != "running"
        for assistant_id in enabled_ids
    ):
        return None
    return installed, tuple(registry[assistant_id] for assistant_id in enabled_ids)


def _selected_ids(response: team.TeamResponse, team_id: str, expected_ids: frozenset[str]) -> tuple[str, ...]:
    body = response.body
    if not isinstance(body, dict) or not isinstance(body.get("assistant_ids"), list):
        raise ValueError("capability plan response is invalid")
    selected = tuple(body["assistant_ids"])
    if (
        body.get("team_id") != team_id
        or body.get("status") not in {"sufficient", "install-required"}
        or selected != tuple(sorted(set(selected)))
        or len(selected) > MAX_PLAN_ASSISTANTS
        or any(assistant_id not in expected_ids for assistant_id in selected)
        or (body.get("status") == "sufficient") != (not selected)
    ):
        raise ValueError("capability plan response is invalid")
    return selected


def _public_enabled_capabilities(
    enabled: tuple[assistant_proposal.Capability, ...],
    catalog: tuple[store_catalog.CatalogAssistant, ...],
) -> tuple[assistant_proposal.Capability, ...]:
    providers = {
        assistant.assistant_id: tuple(integration.provider for integration in assistant.integrations)
        for assistant in catalog
    }
    return tuple(
        assistant_proposal.Capability(
            assistant_id=capability.assistant_id,
            name=capability.name,
            summary=capability.summary,
            actions=capability.actions,
            integrations=providers.get(capability.assistant_id, ()),
        )
        for capability in enabled
    )


def _prepared_plan(
    team_id: str,
    enabled_ids: tuple[str, ...],
    shortlist: tuple[store_catalog.CatalogAssistant, ...],
    selected: tuple[str, ...],
) -> Preparation:
    if not selected:
        return Preparation()
    expected = {assistant.assistant_id: assistant for assistant in shortlist}
    dispatch_ids = tuple(sorted(set(enabled_ids) | set(selected)))
    if len(dispatch_ids) > MAX_CHAT_ASSISTANTS:
        return Preparation(error_status=409)
    return Preparation(
        Plan(
            plan_id=secrets.token_hex(16),
            team_id=team_id,
            assistants=tuple(expected[assistant_id] for assistant_id in selected),
            dispatch_ids=dispatch_ids,
        )
    )


def prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
) -> Preparation:
    """Apply the deterministic gap gate, then admit only an exact planner subset."""
    enabled_ids = tuple(payload["assistant_ids"])
    capabilities = _enabled_capabilities(team_id, enabled_ids)
    if capabilities is None:
        return Preparation()
    installed, enabled = capabilities
    public_catalog = catalog.get()
    shortlist = assistant_proposal.capability_shortlist(
        payload["message"],
        public_catalog,
        installed_ids=frozenset(installed),
        enabled=_public_enabled_capabilities(enabled, public_catalog),
    )
    if not shortlist:
        return Preparation()
    response = local.capability_plan(
        team_id,
        payload["message"],
        [_planner_candidate(assistant) for assistant in shortlist],
    )
    if not isinstance(response, team.TeamResponse) or not 200 <= response.status < 300:
        status = response.status if isinstance(response, team.TeamResponse) and 400 <= response.status <= 599 else 502
        return Preparation(error_status=status)
    try:
        selected = _selected_ids(
            response,
            team_id,
            frozenset(assistant.assistant_id for assistant in shortlist),
        )
    except (TypeError, ValueError):
        return Preparation(error_status=502)
    return _prepared_plan(team_id, enabled_ids, shortlist, selected)


def _items(plan: Plan, states: dict[str, str]) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "id": assistant.assistant_id,
            "name": assistant.name,
            "summary": assistant.summary,
            "providers": sorted({integration.provider for integration in assistant.integrations}),
            "status": states[assistant.assistant_id],
        }
        for assistant in plan.assistants
    )


def initial_items(plan: Plan) -> tuple[dict[str, object], ...]:
    return _items(plan, {assistant.assistant_id: "pending" for assistant in plan.assistants})


def event(
    plan: Plan,
    state: str,
    assistants: tuple[dict[str, object], ...],
    *,
    status: int | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "type": "assistant-install-plan",
        "state": state,
        "plan_id": plan.plan_id,
        "team_id": plan.team_id,
        "assistants": list(assistants),
    }
    if status is not None:
        payload["status"] = status
    return payload


def _install_and_prove_running(
    team_id: str,
    assistant: store_catalog.CatalogAssistant,
) -> int | None:
    try:
        result = assistant_install.install_publication(team_id, assistant)
    except (OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError):
        return 502
    if result.installed is None or not 200 <= result.status < 300:
        return result.status if 400 <= result.status <= 599 else 502
    try:
        installed = assistant_inventory.installed(team.list_installed_assistants(team_id))
    except (TypeError, ValueError, team.TeamRequestError):
        return 502
    current = installed.get(assistant.assistant_id)
    return None if current is not None and current.status == "running" else 502


def execute(
    plan: Plan,
    stopped: threading.Event,
    progress: Callable[[tuple[dict[str, object], ...]], None],
) -> Result:
    """Install sequentially, preserving successful items and stopping only between items."""
    states = {assistant.assistant_id: "pending" for assistant in plan.assistants}
    for assistant in plan.assistants:
        if stopped.is_set():
            return Result("stopped", _items(plan, states))
        states[assistant.assistant_id] = "installing"
        progress(_items(plan, states))
        status = _install_and_prove_running(plan.team_id, assistant)
        if status is not None:
            states[assistant.assistant_id] = "failed"
            return Result("failed", _items(plan, states), status)
        states[assistant.assistant_id] = "installed"
        progress(_items(plan, states))
    return Result("installed", _items(plan, states))
