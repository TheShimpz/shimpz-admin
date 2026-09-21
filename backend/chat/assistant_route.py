"""One structured preparation path for every fresh Local chat objective."""

from __future__ import annotations

import profile as admin_profile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from chat.executor import submit_in_context
from team import bridge as team

from chat import (
    assistant_inventory,
    assistant_plan,
    assistant_proposal,
    assistant_uninstall,
    local,
    store_catalog,
)
from protocol.http.v1 import websocket as chat_ws_common

Intent = Literal["ordinary-task", "assistant-install", "assistant-uninstall", "unresolved"]
LifecycleIntent = Literal["assistant-install", "assistant-uninstall"]
MAX_GUIDANCE_REPLY_CHARS = 240
GuidanceCode = Literal[
    "assistant-install-target-required",
    "assistant-uninstall-target-required",
    "assistant-lifecycle-ambiguous",
]


@dataclass(frozen=True, slots=True)
class Context:
    reference: assistant_proposal.AssistantReference | None = None
    pending_intent: LifecycleIntent | None = None
    language_exemplar: str | None = None


@dataclass(frozen=True, slots=True)
class Route:
    intent: Intent
    query: str = ""
    assistant_ids: tuple[str, ...] = ()
    reply: str = ""


@dataclass(frozen=True, slots=True)
class Guidance:
    code: GuidanceCode
    reply: str


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


def _valid_guidance_reply(value: str) -> bool:
    try:
        return chat_ws_common.public_text(value, MAX_GUIDANCE_REPLY_CHARS, field="Assistant guidance reply") == value
    except ValueError:
        return False


def _safe_status(response: object) -> int:
    return response.status if isinstance(response, team.TeamResponse) and 400 <= response.status <= 599 else 502


def _route(
    team_id: str,
    objective: object,
    expected_intent: str | None,
    candidates: list[dict[str, object]],
    context: local.IntentRouteContext | None = None,
) -> Route:
    response = local.intent_route(team_id, objective, expected_intent, candidates, context)
    if not isinstance(response, team.TeamResponse) or not 200 <= response.status < 300:
        raise RouteError(_safe_status(response))
    body = response.body
    if not isinstance(body, dict) or set(body) != {"team_id", "intent", "query", "assistant_ids", "reply"}:
        raise RouteError(502)
    intent = body["intent"]
    query = body["query"]
    assistant_ids = body["assistant_ids"]
    reply = body["reply"]
    if (
        body["team_id"] != team_id
        or intent not in {"ordinary-task", "assistant-install", "assistant-uninstall", "unresolved"}
        or not isinstance(query, str)
        or not isinstance(assistant_ids, list)
        or any(not isinstance(value, str) for value in assistant_ids)
        or not isinstance(reply, str)
        or (reply and not _valid_guidance_reply(reply))
    ):
        raise RouteError(502)
    if expected_intent is None:
        requires_reply = intent == "unresolved" or (
            intent in {"assistant-install", "assistant-uninstall"} and not query
        )
        if bool(reply) != requires_reply:
            raise RouteError(502)
    elif (intent == "unresolved") != bool(reply):
        raise RouteError(502)
    return Route(intent, query, tuple(assistant_ids), reply)


def _guidance(intent: LifecycleIntent, reply: str) -> Guidance:
    code: GuidanceCode = (
        "assistant-install-target-required" if intent == "assistant-install" else "assistant-uninstall-target-required"
    )
    return Guidance(code, reply)


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
    language_exemplar: str | None,
) -> Result:
    installed, available = _catalog_state(team_id, catalog, include_local)
    shortlist = assistant_proposal.install_shortlist(query, available)
    selection = _route(
        team_id,
        payload["message"],
        "assistant-install",
        [_directory_candidate(assistant) for assistant in shortlist],
        local.IntentRouteContext(language_exemplar=language_exemplar),
    )
    if selection.intent == "unresolved":
        return Result("assistant-install", guidance=_guidance("assistant-install", selection.reply))
    preparation = assistant_plan.prepare_install(team_id, payload, selection.assistant_ids, installed, available)
    return Result("assistant-install", preparation=preparation)


def _prepare_uninstall(
    team_id: str,
    payload: dict[str, object],
    query: str,
    language_exemplar: str | None,
) -> Result:
    shortlist = assistant_proposal.uninstall_shortlist(query, assistant_uninstall.candidates(team_id))
    selection = _route(
        team_id,
        payload["message"],
        "assistant-uninstall",
        [_uninstall_candidate(candidate) for candidate in shortlist],
        local.IntentRouteContext(language_exemplar=language_exemplar),
    )
    if selection.intent == "unresolved":
        return Result("assistant-uninstall", guidance=_guidance("assistant-uninstall", selection.reply))
    matches = tuple(candidate for candidate in shortlist if candidate.assistant.assistant_id in selection.assistant_ids)
    if len(matches) != 1:
        raise RouteError(502)
    return Result("assistant-uninstall", uninstall=matches[0])


def _classified_install(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    catalog: store_catalog.StoreCatalog,
    include_local: bool,
    language_exemplar: str | None,
) -> Result:
    if not classification.query:
        return Result(
            "assistant-install",
            guidance=_guidance("assistant-install", classification.reply),
        )
    return _prepare_install(
        team_id,
        payload,
        classification.query,
        catalog,
        include_local,
        language_exemplar,
    )


def _classified_uninstall(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    language_exemplar: str | None,
    *,
    allow_uninstall: bool,
) -> Result:
    if not allow_uninstall:
        return Result("unresolved", error_status=422)
    if not classification.query:
        return Result(
            "assistant-uninstall",
            guidance=_guidance("assistant-uninstall", classification.reply),
        )
    return _prepare_uninstall(
        team_id,
        payload,
        classification.query,
        language_exemplar,
    )


def _lifecycle_result(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    route_context: Context,
    catalog: store_catalog.StoreCatalog,
    include_local: bool,
    *,
    allow_uninstall: bool,
) -> Result:
    if payload["files"]:
        return Result("unresolved", error_status=422)
    if classification.intent == "unresolved":
        guidance = (
            _guidance(route_context.pending_intent, classification.reply)
            if route_context.pending_intent is not None
            else Guidance("assistant-lifecycle-ambiguous", classification.reply)
        )
        return Result("unresolved", guidance=guidance)
    if classification.intent == "assistant-install":
        return _classified_install(
            team_id,
            payload,
            classification,
            catalog,
            include_local,
            route_context.language_exemplar,
        )
    return _classified_uninstall(
        team_id,
        payload,
        classification,
        route_context.language_exemplar,
        allow_uninstall=allow_uninstall,
    )


def _prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
    context: Context | None = None,
    *,
    allow_uninstall: bool,
) -> Result:
    """Classify once, then lazily open only the required bounded directory."""
    route_context = context or Context()
    classification = _route(
        team_id,
        payload["message"],
        None,
        [],
        local.IntentRouteContext(
            reference=route_context.reference,
            pending_intent=route_context.pending_intent,
            language_exemplar=(route_context.language_exemplar if route_context.pending_intent is not None else None),
        ),
    )
    if classification.intent == "ordinary-task":
        preparation = assistant_plan.prepare_capability(
            team_id,
            payload,
            catalog,
            admin_profile.require() == "local" if include_local is None else include_local,
        )
        return Result(classification.intent, preparation=preparation)
    local_enabled = admin_profile.require() == "local" if include_local is None else include_local
    return _lifecycle_result(
        team_id,
        payload,
        classification,
        route_context,
        catalog,
        local_enabled,
        allow_uninstall=allow_uninstall,
    )


def prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
    context: Context | None = None,
) -> Result:
    """Classify a fresh chat turn and open only its required bounded directory."""
    return _prepare(team_id, payload, catalog, include_local, context, allow_uninstall=True)


def prepare_resume(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    include_local: bool | None = None,
) -> Result:
    """Reclassify a reconnect objective without admitting destructive lifecycle work."""
    return _prepare(team_id, payload, catalog, include_local, None, allow_uninstall=False)
