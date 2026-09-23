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

from chat import assistant_install, assistant_inventory, assistant_proposal, local, local_catalog, store_catalog

MAX_PLAN_ASSISTANTS = 4
MAX_CHAT_ASSISTANTS = 16


@dataclass(frozen=True, slots=True)
class Plan:
    plan_id: str
    team_id: str
    assistants: tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...]
    dispatch_ids: tuple[str, ...]
    terminal: bool = False
    lifecycle_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AlreadyInstalled:
    plan_id: str
    team_id: str
    assistants: tuple[dict[str, object], ...]


@dataclass(frozen=True, slots=True)
class Preparation:
    plan: Plan | None = None
    already_installed: AlreadyInstalled | None = None
    error_status: int | None = None


@dataclass(frozen=True, slots=True)
class Result:
    state: Literal["installed", "failed", "stopped"]
    assistants: tuple[dict[str, object], ...]
    status: int | None = None


def _planner_candidate(
    assistant: store_catalog.CatalogAssistant | local_catalog.LocalAssistant,
) -> dict[str, object]:
    return {
        "id": assistant.assistant_id,
        "name": assistant.name,
        "summary": assistant.summary,
        "actions": list(assistant.actions),
        "integrations": [
            {"id": integration.provider, "provider": integration.provider} for integration in assistant.integrations
        ],
    }


def installed_inventory(team_id: str) -> dict[str, assistant_inventory.InstalledAssistant]:
    return assistant_inventory.installed(team.list_installed_assistants(team_id))


def team_inventory(
    team_id: str,
) -> tuple[
    dict[str, assistant_inventory.InstalledAssistant],
    dict[str, assistant_proposal.Capability],
]:
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-inventory") as executor:
        installed_future = submit_in_context(executor, team.list_installed_assistants, team_id)
        registry_future = submit_in_context(executor, team.list_assistants)
        installed_response = installed_future.result()
        registry_response = registry_future.result()
    installed = assistant_inventory.installed(installed_response)
    registry = assistant_inventory.registry(registry_response)
    return installed, registry


def _enabled_capabilities(
    enabled_ids: tuple[str, ...],
    installed: dict[str, assistant_inventory.InstalledAssistant],
    registry: dict[str, assistant_proposal.Capability],
) -> tuple[assistant_proposal.Capability, ...] | None:
    if any(
        assistant_id not in registry or assistant_id not in installed or installed[assistant_id].status != "running"
        for assistant_id in enabled_ids
    ):
        return None
    return tuple(registry[assistant_id] for assistant_id in enabled_ids)


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


def _enabled_capabilities_with_providers(
    enabled: tuple[assistant_proposal.Capability, ...],
    catalog: tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...],
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
    shortlist: tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...],
    selected: tuple[str, ...],
    *,
    terminal: bool = False,
    dispatch_selected: tuple[str, ...] | None = None,
    lifecycle_ids: tuple[str, ...] = (),
) -> Preparation:
    if not selected:
        return Preparation()
    expected = {assistant.assistant_id: assistant for assistant in shortlist}
    dispatch_ids = tuple(sorted(set(enabled_ids) | set(dispatch_selected or selected)))
    if len(dispatch_ids) > MAX_CHAT_ASSISTANTS:
        return Preparation(error_status=409)
    return Preparation(
        Plan(
            plan_id=secrets.token_hex(16),
            team_id=team_id,
            assistants=tuple(expected[assistant_id] for assistant_id in selected),
            dispatch_ids=dispatch_ids,
            terminal=terminal,
            lifecycle_ids=lifecycle_ids,
        )
    )


def planning_catalog(
    catalog: store_catalog.StoreCatalog,
    include_local: bool,
) -> tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...]:
    if include_local:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="assistant-catalog") as executor:
            local_future = submit_in_context(executor, team.list_local_assistants)
            public = catalog.get()
            local_assistants = local_catalog.primary(local_future.result())
    else:
        public = catalog.get()
        local_assistants = ()
    local_ids = {assistant.assistant_id for assistant in local_assistants}
    combined = (*local_assistants, *(assistant for assistant in public if assistant.assistant_id not in local_ids))
    return tuple(sorted(combined, key=lambda assistant: assistant.assistant_id))


def _prepare_gap(
    team_id: str,
    message: str,
    available: tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...],
    installed: dict[str, assistant_inventory.InstalledAssistant],
    enabled: tuple[assistant_proposal.Capability, ...],
) -> Preparation:
    shortlist = assistant_proposal.capability_shortlist(
        message,
        available,
        installed_ids=frozenset(installed),
        enabled=_enabled_capabilities_with_providers(enabled, available),
    )
    if not shortlist:
        return Preparation()
    response = local.capability_plan(
        team_id,
        message,
        [_planner_candidate(assistant) for assistant in shortlist],
    )
    if not isinstance(response, team.TeamResponse) or not 200 <= response.status < 300:
        return Preparation()
    try:
        selected = _selected_ids(
            response,
            team_id,
            frozenset(assistant.assistant_id for assistant in shortlist),
        )
    except TypeError, ValueError:
        return Preparation()
    return _prepared_plan(team_id, tuple(capability.assistant_id for capability in enabled), shortlist, selected)


def prepare_capability(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool = False,
) -> Preparation:
    """Resolve exact current state, then apply the deterministic missing-capability gate."""
    installed, registry = team_inventory(team_id)
    enabled = _enabled_capabilities(tuple(payload["assistant_ids"]), installed, registry)
    if enabled is None:
        return Preparation()
    try:
        available = planning_catalog(catalog, include_local)
    except OSError, ValueError, team.TeamRequestError:
        return Preparation()
    return _prepare_gap(team_id, payload["message"], available, installed, enabled)


def prepare_install(
    team_id: str,
    payload: dict[str, object],
    selected_ids: tuple[str, ...],
    installed: dict[str, assistant_inventory.InstalledAssistant],
    available: tuple[store_catalog.CatalogAssistant | local_catalog.LocalAssistant, ...],
) -> Preparation:
    """Bind a structured install selection to exact current state and a terminal plan."""
    if not selected_ids or len(selected_ids) > MAX_PLAN_ASSISTANTS:
        return Preparation(error_status=422)
    identities = {assistant.assistant_id: assistant for assistant in available}
    if any(assistant_id not in identities for assistant_id in selected_ids):
        return Preparation(error_status=409)
    missing = tuple(
        assistant_id
        for assistant_id in selected_ids
        if assistant_id not in installed or installed[assistant_id].status != "running"
    )
    if not missing:
        return Preparation(
            already_installed=AlreadyInstalled(
                plan_id=secrets.token_hex(16),
                team_id=team_id,
                assistants=tuple(
                    {
                        "id": assistant_id,
                        "name": identities[assistant_id].name,
                        "summary": identities[assistant_id].summary,
                        "providers": sorted(
                            {integration.provider for integration in identities[assistant_id].integrations}
                        ),
                        "provenance": installed[assistant_id].provenance,
                        "status": "installed",
                    }
                    for assistant_id in selected_ids
                ),
            )
        )
    return _prepared_plan(
        team_id,
        tuple(payload["assistant_ids"]),
        available,
        missing,
        terminal=True,
        dispatch_selected=selected_ids,
        lifecycle_ids=selected_ids,
    )


def _items(plan: Plan, states: dict[str, str]) -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "id": assistant.assistant_id,
            "name": assistant.name,
            "summary": assistant.summary,
            "providers": sorted({integration.provider for integration in assistant.integrations}),
            "provenance": "local" if isinstance(assistant, local_catalog.LocalAssistant) else "published",
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
    continuation: Literal["dispatch", "none"] | None = None,
) -> dict[str, object]:
    if state == "installed":
        if continuation not in {"dispatch", "none"}:
            raise ValueError("installed Assistant plan continuation is invalid")
    elif continuation is not None:
        raise ValueError("Assistant plan continuation is only valid after installation")
    payload: dict[str, object] = {
        "type": "assistant-install-plan",
        "state": state,
        "plan_id": plan.plan_id,
        "team_id": plan.team_id,
        "assistants": list(assistants),
    }
    if status is not None:
        payload["status"] = status
    if continuation is not None:
        payload["continuation"] = continuation
    return payload


def already_installed_event(result: AlreadyInstalled) -> dict[str, object]:
    """Project one terminal, idempotent response without claiming a fresh install."""
    return {
        "type": "assistant-install-plan",
        "state": "installed",
        "plan_id": result.plan_id,
        "team_id": result.team_id,
        "assistants": list(result.assistants),
        "continuation": "none",
        "outcome": "already-installed",
    }


def _install_and_prove_running(
    team_id: str,
    assistant: store_catalog.CatalogAssistant | local_catalog.LocalAssistant,
) -> int | None:
    try:
        result = (
            assistant_install.install_local_snapshot(team_id, assistant)
            if isinstance(assistant, local_catalog.LocalAssistant)
            else assistant_install.install_publication(team_id, assistant)
        )
    except OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError:
        return 502
    if result.installed is None or not 200 <= result.status < 300:
        return result.status if 400 <= result.status <= 599 else 502
    try:
        installed = assistant_inventory.installed(team.list_installed_assistants(team_id))
    except TypeError, ValueError, team.TeamRequestError:
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
