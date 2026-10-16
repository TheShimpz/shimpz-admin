"""One structured preparation path for every fresh Local chat objective."""

from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from typing import Literal

import decision
import state
from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from history import context as conversation_context
from team import transport

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
# How long classification waits for the plan's shortlist so it can describe it to the decision provider; a slower
# shortlist only means this turn classifies without it and waits for its plan as before (ADR-0077 amendment).
GAP_WAIT_SECONDS = 0.4
GuidanceCode = Literal[
    "assistant-install-target-required",
    "assistant-uninstall-target-required",
    "assistant-lifecycle-ambiguous",
    "assistant-lifecycle-attachments",
    "assistant-capability-attachments",
    "assistant-uninstall-replacement",
]
# Platform guidance in every interface language: attachments never install or remove an Assistant, and a missing
# capability is installed only from an attachment-free request (ADR-0093); an Assistant whose binding the current
# contract refuses has no card to confirm, so the chat never removes it and never proposes another in its place.
PLATFORM_GUIDANCE: dict[str, dict[str, str]] = {
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
    "assistant-uninstall-replacement": {
        "ar": "يحتاج هذا المساعد إلى الاستبدال، لذا لا يمكن إزالته من المحادثة. ألغِ تثبيته من صفحته في المتجر.",
        "de": (
            "Dieser Assistent muss ersetzt werden und kann daher nicht im Chat entfernt werden. "
            "Deinstalliere ihn auf seiner Seite im Store."
        ),
        "en": (
            "This Assistant needs to be replaced, so it can't be removed from the chat. "
            "Uninstall it from its Store page."
        ),
        "es": (
            "Este Asistente necesita reemplazarse, así que no puede quitarse desde el chat. "
            "Desinstálalo desde su página en la Tienda."
        ),
        "fr": (
            "Cet Assistant doit être remplacé, il ne peut donc pas être retiré depuis la conversation. "
            "Désinstallez-le depuis sa page dans la Boutique."
        ),
        "ja": (
            "このアシスタントは置き換えが必要なため、チャットからは削除できません。"
            "ストアのページからアンインストールしてください。"
        ),
        "pt": (
            "Este Assistente precisa ser substituído, então não pode ser removido pela conversa. "
            "Desinstale-o na página dele na Loja."
        ),
        "zh": "此助手需要替换，因此无法在对话中移除。请在商店中的助手页面将其卸载。",
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
    # The decision provider called this ordinary task capability-free: no Assistant it could install would serve it.
    capability_free: bool = False


@dataclass(frozen=True, slots=True)
class Guidance:
    code: GuidanceCode
    reply: str


@dataclass(frozen=True, slots=True)
class Result:
    intent: Intent
    preparation: assistant_plan.Preparation | None = None
    uninstall: assistant_proposal.UninstallTarget | None = None
    guidance: Guidance | None = None
    error_status: int | None = None


class RouteError(RuntimeError):
    def __init__(self, status: int, event: dict[str, object] | None = None) -> None:
        super().__init__("structured Assistant routing failed")
        self.status = status
        # Chat's own public refusal the turn ends with instead of the routing failure, when it names a remedy.
        self.event = event


def _refusal(response: object, team_id: str) -> dict[str, object] | None:
    """Chat's refusal of a broken stored key record, whose public words name the Space reset that repairs it."""
    if isinstance(response, local.PublicResponse) and response.body.get("code") == "credential-record-invalid":
        return response.websocket_event(team_id)
    return None


def _valid_guidance_reply(value: str) -> bool:
    try:
        return chat_ws_common.public_text(value, MAX_GUIDANCE_REPLY_CHARS, field="Assistant guidance reply") == value
    except ValueError:
        return False


def _safe_status(response: object) -> int:
    return response.status if isinstance(response, transport.TeamResponse) and 400 <= response.status <= 599 else 502


def _route(
    team_id: str,
    objective: object,
    expected_intent: str | None,
    candidates: list[dict[str, object]],
    context: local.IntentRouteContext,
    installable: list[dict[str, str]] | None = None,
) -> Route:
    response = local.intent_route(team_id, objective, expected_intent, candidates, context, installable)
    if not isinstance(response, transport.TeamResponse) or not 200 <= response.status < 300:
        raise RouteError(_safe_status(response), _refusal(response, team_id))
    body = response.body
    if not isinstance(body, dict):
        raise RouteError(502)
    body = dict(body)
    capability = body.pop("capability", None)
    if set(body) != {
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
    if capability not in {None, "not-needed", "possible"} or (capability == "not-needed" and intent != "ordinary-task"):
        raise RouteError(502)
    return Route(intent, query, tuple(assistant_ids), reply, task_follows, capability == "not-needed")


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
    query: str,
    locale: str,
) -> Result:
    directory = assistant_uninstall.candidates(team_id)
    shortlist = assistant_proposal.uninstall_shortlist(query, directory.candidates)
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
    match = matches[0]
    if match.assistant.assistant_id in directory.refused:
        return Result("assistant-uninstall", guidance=_platform_guidance("assistant-uninstall-replacement", locale))
    try:
        creator = assistant_inventory.binding_creator(team_id, match.assistant.assistant_id, match.version)
    except ValueError, transport.TeamRequestError:
        raise RouteError(502) from None
    return Result("assistant-uninstall", uninstall=assistant_proposal.UninstallTarget(match, creator))


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
        classification.query,
        locale,
    )


def _platform_guidance(code: GuidanceCode, locale: str) -> Guidance:
    return Guidance(code, PLATFORM_GUIDANCE[code][locale])


def _lifecycle_result(
    team_id: str,
    payload: dict[str, object],
    classification: Route,
    catalog: store_catalog.StoreCatalog,
    *,
    allow_uninstall: bool,
) -> Result:
    locale = payload["locale"]
    if payload["files"]:
        return Result(classification.intent, guidance=_platform_guidance("assistant-lifecycle-attachments", locale))
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
        classification,
        locale,
        allow_uninstall=allow_uninstall,
    )


def _speculate(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    gap_ready: Future,
) -> assistant_plan.Preparation:
    """Resolve the plan's gap, hand it to classification as soon as it exists, then plan over it."""
    try:
        gap = assistant_plan.capability_gap(team_id, payload, catalog)
    except BaseException as exc:
        gap_ready.set_exception(exc)
        raise
    gap_ready.set_result(gap)
    return assistant_plan.plan_gap(team_id, payload, gap, catalog)


def _installable(gap_ready: Future) -> list[dict[str, str]] | None:
    """The plan's shortlist for classification, when a decision key may receive it and it exists within the bound.

    A stored TypeSafe record Admin did not write describes nothing: the classification reads it again, and the turn ends
    with chat's refusal that names the Space reset (RouteError.event).
    """
    try:
        if decision.resolve() is None:
            return None
    except state.CredentialRecordError:
        return None
    try:
        if gap_ready.exception(timeout=GAP_WAIT_SECONDS) is not None:
            return None
    except FutureTimeoutError:
        return None
    gap = gap_ready.result()
    return gap.installable() if gap is not None and gap.shortlist else None


def _prepare(
    team_id: str,
    payload: dict[str, object],
    catalog: store_catalog.StoreCatalog,
    context: Context | None = None,
    *,
    allow_uninstall: bool,
) -> Result:
    """Classify once while speculatively planning capabilities, then keep only the result the route needs.

    Classification describes the plan's own shortlist to the decision provider when it can; a confident
    capability-free answer for an ordinary task dispatches it without waiting for that plan (ADR-0077 amendment).
    """
    route_context = context or Context()
    gap_ready: Future = Future()
    try:
        capability = submit_in_context(_CAPABILITY_PLANNING, _speculate, team_id, payload, catalog, gap_ready)
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
            _installable(gap_ready) if capability is not None else None,
        )
    except BaseException:
        if capability is not None:
            capability.cancel()
        raise
    if classification.intent == "ordinary-task":
        if classification.capability_free and capability is not None:
            # The plan may already be running; it ends on its own and its answer is discarded.
            capability.cancel()
            return Result(classification.intent, preparation=assistant_plan.Preparation())
        preparation = (
            capability.result()
            if capability is not None
            else assistant_plan.prepare_capability(team_id, payload, catalog)
        )
        if payload["files"] and preparation.plan is not None:
            # A message with attachments never installs a capability; it is explained instead (ADR-0093).
            guidance = _platform_guidance("assistant-capability-attachments", payload["locale"])
            return Result(classification.intent, guidance=guidance)
        return Result(classification.intent, preparation=preparation)
    if capability is not None:
        capability.cancel()
    return _lifecycle_result(
        team_id,
        payload,
        classification,
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
