"""One structured preparation path for every fresh Local chat objective."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Literal

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from history import context as conversation_context
from team import bridge as team

from chat import (
    assistant_inventory,
    assistant_plan,
    assistant_proposal,
    assistant_uninstall,
    local,
    store_catalog,
)
from protocol.http.v1 import turn as turn_contract
from protocol.http.v1 import websocket as chat_ws_common

Intent = Literal["ordinary-task", "assistant-install", "assistant-uninstall", "unresolved"]
LifecycleIntent = Literal["assistant-install", "assistant-uninstall"]
MAX_GUIDANCE_REPLY_CHARS = turn_contract.MAX_INTENT_ROUTE_REPLY_CHARS
# Capability planning runs beside classification so an ordinary turn waits for the slower call, not both.
_CAPABILITY_PLANNING = BoundedThreadPoolExecutor(
    max_workers=4,
    max_outstanding=8,
    thread_name_prefix="assistant-capability-plan",
)
GuidanceCode = Literal[
    "assistant-install-target-required",
    "assistant-uninstall-target-required",
    "assistant-lifecycle-ambiguous",
    "assistant-lifecycle-attachments",
    "assistant-capability-attachments",
]
# Platform guidance for a message that carried attachments, in every interface language (ADR-0093): attachments never
# install or remove an Assistant, and a missing capability is installed only from an attachment-free request.
ATTACHMENT_GUIDANCE: dict[str, dict[str, str]] = {
    "assistant-lifecycle-attachments": {
        "ar": "لا يمكن استخدام المرفقات لتثبيت المساعدين أو إزالتهم. أرسل هذا الطلب مرة أخرى بدون مرفقات.",
        "de": (
            "Anhänge können nicht zum Installieren oder Entfernen von Assistenten verwendet werden. "
            "Sende diese Anfrage erneut ohne Anhänge."
        ),
        "en": "Attachments can't be used to install or remove Assistants. Send that request again without attachments.",
        "es": (
            "Los adjuntos no pueden usarse para instalar o quitar Asistentes. "
            "Envía esa solicitud de nuevo sin adjuntos."
        ),
        "fr": (
            "Les pièces jointes ne peuvent pas servir à installer ou retirer des Assistants. "
            "Renvoyez cette demande sans pièces jointes."
        ),
        "ja": (
            "添付ファイルを使ってアシスタントをインストールまたは削除することはできません。"
            "添付ファイルなしでもう一度送信してください。"
        ),
        "pt": (
            "Anexos não podem ser usados para instalar ou remover Assistentes. Envie esse pedido de novo sem anexos."
        ),
        "zh": "附件不能用于安装或移除助手。请不带附件重新发送该请求。",
    },
    "assistant-capability-attachments": {
        "ar": "تحتاج هذه المهمة إلى مساعد لم يُثبَّت بعد. لتثبيته، أرسل الطلب مرة أخرى بدون مرفقات.",
        "de": (
            "Für diese Aufgabe wird ein Assistent benötigt, der noch nicht installiert ist. "
            "Sende die Anfrage zum Installieren erneut ohne Anhänge."
        ),
        "en": (
            "This task needs an Assistant that isn't installed yet. "
            "To install it, send the request again without attachments."
        ),
        "es": (
            "Esta tarea necesita un Asistente que aún no está instalado. "
            "Para instalarlo, envía la solicitud de nuevo sin adjuntos."
        ),
        "fr": (
            "Cette tâche nécessite un Assistant qui n'est pas encore installé. "
            "Pour l'installer, renvoyez la demande sans pièces jointes."
        ),
        "ja": (
            "このタスクには、まだインストールされていないアシスタントが必要です。"
            "インストールするには、添付ファイルなしでもう一度送信してください。"
        ),
        "pt": (
            "Esta tarefa precisa de um Assistente que ainda não está instalado. "
            "Para instalá-lo, envie o pedido de novo sem anexos."
        ),
        "zh": "此任务需要一个尚未安装的助手。如需安装，请不带附件重新发送该请求。",
    },
}


@dataclass(frozen=True, slots=True)
class Context:
    reference: assistant_proposal.AssistantReference | None = None
    conversation: tuple[conversation_context.Entry, ...] = ()


@dataclass(frozen=True, slots=True)
class Route:
    intent: Intent
    query: str = ""
    assistant_ids: tuple[str, ...] = ()
    reply: str = ""
    task_follows: bool = False


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
    if not isinstance(body, dict) or set(body) != {
        "team_id",
        "intent",
        "query",
        "assistant_ids",
        "reply",
        "task_follows",
    }:
        raise RouteError(502)
    task_follows = body["task_follows"]
    if type(task_follows) is not bool or (
        task_follows and (expected_intent is not None or body["intent"] != "assistant-install")
    ):
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
    return Route(intent, query, tuple(assistant_ids), reply, task_follows)


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
) -> tuple[
    dict[str, assistant_inventory.InstalledAssistant],
    tuple[assistant_proposal.DirectoryAssistant, ...],
]:
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-route-directory") as executor:
        inventory_future = submit_in_context(executor, assistant_plan.installed_inventory, team_id)
        catalog_future = submit_in_context(executor, assistant_plan.planning_catalog, catalog)
        installed = inventory_future.result()
        available = catalog_future.result()
    return installed, available


def _prepare_install(
    team_id: str,
    payload: dict[str, object],
    query: str,
    catalog: store_catalog.StoreCatalog,
    locale: str,
    task_follows: bool = False,
) -> Result:
    installed, available = _catalog_state(team_id, catalog)
    shortlist = assistant_proposal.install_shortlist(query, available)
    selection = _route(
        team_id,
        query,
        "assistant-install",
        [_directory_candidate(assistant) for assistant in shortlist],
        local.IntentRouteContext(locale=locale),
    )
    if selection.intent == "unresolved":
        return Result("assistant-install", guidance=_guidance("assistant-install", selection.reply))
    preparation = assistant_plan.prepare_install(
        team_id,
        payload,
        selection.assistant_ids,
        installed,
        available,
        catalog,
        task_follows=task_follows,
    )
    return Result("assistant-install", preparation=preparation)


def _prepare_uninstall(
    team_id: str,
    payload: dict[str, object],
    query: str,
    locale: str,
) -> Result:
    shortlist = assistant_proposal.uninstall_shortlist(query, assistant_uninstall.candidates(team_id))
    selection = _route(
        team_id,
        query,
        "assistant-uninstall",
        [_uninstall_candidate(candidate) for candidate in shortlist],
        local.IntentRouteContext(locale=locale),
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
    locale: str,
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
        locale,
        classification.task_follows,
    )


def _classified_uninstall(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    locale: str,
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
        locale,
    )


def _attachment_guidance(code: GuidanceCode, locale: str) -> Guidance:
    return Guidance(code, ATTACHMENT_GUIDANCE[code][locale])


def _lifecycle_result(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    route_context: Context,
    catalog: store_catalog.StoreCatalog,
    *,
    allow_uninstall: bool,
) -> Result:
    locale = payload["locale"]
    if payload["files"]:
        return Result(classification.intent, guidance=_attachment_guidance("assistant-lifecycle-attachments", locale))
    if classification.intent == "unresolved":
        return Result("unresolved", guidance=Guidance("assistant-lifecycle-ambiguous", classification.reply))
    if classification.intent == "assistant-install":
        return _classified_install(
            team_id,
            payload,
            classification,
            catalog,
            locale,
        )
    return _classified_uninstall(
        team_id,
        payload,
        classification,
        locale,
        allow_uninstall=allow_uninstall,
    )


def _prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    context: Context | None = None,
    *,
    allow_uninstall: bool,
) -> Result:
    """Classify once while speculatively planning capabilities, then keep only the result the route needs."""
    route_context = context or Context()
    try:
        capability = submit_in_context(
            _CAPABILITY_PLANNING,
            assistant_plan.prepare_capability,
            team_id,
            payload,
            catalog,
        )
    except ExecutorSaturatedError:
        capability = None
    try:
        classification = _route(
            team_id,
            payload["message"],
            None,
            [],
            local.IntentRouteContext(
                reference=route_context.reference,
                conversation=route_context.conversation,
                locale=payload["locale"],
            ),
        )
    except BaseException:
        if capability is not None:
            capability.cancel()
        raise
    if classification.intent == "ordinary-task":
        preparation = (
            capability.result()
            if capability is not None
            else assistant_plan.prepare_capability(team_id, payload, catalog)
        )
        if payload["files"] and preparation.plan is not None:
            # A message with attachments never installs a capability; it is explained instead (ADR-0093).
            guidance = _attachment_guidance("assistant-capability-attachments", payload["locale"])
            return Result(classification.intent, guidance=guidance)
        return Result(classification.intent, preparation=preparation)
    if capability is not None:
        capability.cancel()
    return _lifecycle_result(
        team_id,
        payload,
        classification,
        route_context,
        catalog,
        allow_uninstall=allow_uninstall,
    )


def prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    context: Context | None = None,
) -> Result:
    """Classify a fresh chat turn and open only its required bounded directory."""
    return _prepare(team_id, payload, catalog, context, allow_uninstall=True)


def prepare_resume(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
) -> Result:
    """Reclassify a reconnect objective without admitting destructive lifecycle work."""
    return _prepare(team_id, payload, catalog, None, allow_uninstall=False)
