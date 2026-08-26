"""Socket-scoped discovery, confirmation, and Assistant lifecycle execution."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Protocol

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import WebSocket
from team import bridge as team

from chat import assistant_install, assistant_proposal, assistant_uninstall, local, store_catalog

_DISCOVERY_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-discovery",
)
_LIFECYCLE_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-lifecycle",
)
_STORE_CATALOG = store_catalog.CATALOG
DISCOVERY_GRACE_SECONDS = 0.25
monotonic = time.monotonic

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]


@dataclass(slots=True)
class Operation:
    proposal: assistant_proposal.Proposal
    future: concurrent.futures.Future
    delivery: asyncio.Task | None = None


class Connection(Protocol):
    closed: bool
    lifecycle_proposal: assistant_proposal.Proposal | None
    lifecycle: Operation | None


def _assistant_identity(proposal: assistant_proposal.Proposal) -> dict[str, object]:
    assistant = proposal.assistant
    identity: dict[str, object] = {
        "id": assistant.assistant_id,
        "name": assistant.name,
        "summary": assistant.summary,
    }
    if isinstance(proposal, assistant_proposal.UninstallProposal):
        identity["version"] = proposal.assistant_version
    else:
        identity["providers"] = sorted({item.provider for item in assistant.integrations})
    return identity


def _event_type(proposal: assistant_proposal.Proposal) -> str:
    return (
        "assistant-uninstall"
        if isinstance(proposal, assistant_proposal.UninstallProposal)
        else "assistant-install"
    )


def _proposal_event(
    proposal: assistant_proposal.Proposal,
    terminal: Mapping[str, object],
) -> dict[str, object]:
    return {
        "type": _event_type(proposal),
        "state": "proposed",
        "proposal_id": proposal.proposal_id,
        "team_id": proposal.team_id,
        "reply": terminal["reply"],
        "expires_in": (
            assistant_proposal.UNINSTALL_PROPOSAL_TTL_SECONDS
            if isinstance(proposal, assistant_proposal.UninstallProposal)
            else assistant_proposal.INSTALL_PROPOSAL_TTL_SECONDS
        ),
        "assistant": _assistant_identity(proposal),
    }


def _event(
    proposal: assistant_proposal.Proposal,
    state: str,
    **fields: object,
) -> dict[str, object]:
    return {
        "type": _event_type(proposal),
        "state": state,
        "proposal_id": proposal.proposal_id,
        "assistant_id": proposal.assistant.assistant_id,
        **fields,
    }


def _discover(
    team_id: str,
    payload: dict[str, object],
) -> store_catalog.CatalogAssistant | assistant_proposal.UninstallCandidate | None:
    message = payload["message"]
    if assistant_proposal.uninstall_requested(message):
        return assistant_uninstall.discover(team_id, message)
    return assistant_install.discover(
        team_id,
        message,
        tuple(payload["assistant_ids"]),
        _STORE_CATALOG,
    )


def submit_discovery(
    team_id: str,
    payload: dict[str, object],
) -> concurrent.futures.Future | None:
    """Start optional discovery without letting its failure affect ordinary chat."""
    try:
        return submit_in_context(
            _DISCOVERY_EXECUTOR,
            _discover,
            team_id,
            payload,
        )
    except (
        ExecutorSaturatedError,
        OSError,
        RuntimeError,
        TypeError,
        ValueError,
        team.TeamRequestError,
    ):
        return None


def cancel_discovery(future: concurrent.futures.Future | None) -> None:
    """Cancel discovery that has not started; running bounded work may finish harmlessly."""
    if future is not None and not future.done():
        future.cancel()


async def _await_discovery(
    future: concurrent.futures.Future | None,
) -> store_catalog.CatalogAssistant | assistant_proposal.UninstallCandidate | None:
    if future is None:
        return None
    try:
        candidate = await asyncio.wrap_future(future)
    except asyncio.CancelledError:
        raise
    except OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError:
        return None
    return (
        candidate
        if isinstance(candidate, store_catalog.CatalogAssistant | assistant_proposal.UninstallCandidate)
        else None
    )


async def attach_proposal(
    connection: Connection,
    discovery_future: concurrent.futures.Future | None,
    team_id: str,
    event: dict[str, object],
    *,
    language_exemplar: object,
) -> dict[str, object]:
    """Attach one strong candidate to a successful turn without changing failures."""
    if event.get("type") != "done":
        cancel_discovery(discovery_future)
        return event
    try:
        candidate = await asyncio.wait_for(
            _await_discovery(discovery_future),
            timeout=DISCOVERY_GRACE_SECONDS,
        )
    except TimeoutError:
        cancel_discovery(discovery_future)
        return event
    if candidate is None or connection.lifecycle_proposal is not None:
        return event
    try:
        if isinstance(candidate, assistant_proposal.UninstallCandidate):
            proposal = assistant_proposal.create_uninstall_proposal(
                team_id,
                candidate,
                language_exemplar=language_exemplar,
                now=monotonic(),
            )
        else:
            proposal = assistant_proposal.create_install_proposal(
                team_id,
                candidate,
                language_exemplar=language_exemplar,
                now=monotonic(),
            )
    except ValueError:
        return event
    connection.lifecycle_proposal = proposal
    return _proposal_event(proposal, event)


async def _deliver(
    websocket: WebSocket,
    connection: Connection,
    operation: Operation,
    send_event: SendEvent,
) -> None:
    task = asyncio.current_task()
    try:
        result: assistant_install.InstallResult | assistant_uninstall.UninstallResult | None = None
        with contextlib.suppress(Exception):
            resolved = await asyncio.wrap_future(operation.future)
            if isinstance(resolved, assistant_install.InstallResult | assistant_uninstall.UninstallResult):
                result = resolved
        if connection.closed:
            return
        event = _result_event(operation.proposal, result)
        if not await send_event(websocket, event):
            connection.closed = True
    finally:
        if operation.delivery is task and connection.lifecycle is operation:
            connection.lifecycle = None


def _result_event(
    proposal: assistant_proposal.Proposal,
    result: assistant_install.InstallResult | assistant_uninstall.UninstallResult | None,
) -> dict[str, object]:
    if isinstance(proposal, assistant_proposal.UninstallProposal):
        return _uninstall_result_event(proposal, result)
    return _install_result_event(proposal, result)


def _install_result_event(
    proposal: assistant_proposal.InstallProposal,
    result: assistant_install.InstallResult | assistant_uninstall.UninstallResult | None,
) -> dict[str, object]:
    if (
        isinstance(result, assistant_install.InstallResult)
        and 200 <= result.status < 300
        and result.installed is not None
    ):
        labels = result.labels
        return _event(
            proposal,
            "installed",
            team_id=proposal.team_id,
            installed=result.installed,
            **(
                {
                    "assistant_version": labels.assistant_version,
                    "actions": [{"id": action.action_id, "label": action.label} for action in labels.actions],
                }
                if labels is not None
                else {}
            ),
        )
    status = result.status if result is not None and 400 <= result.status <= 599 else 502
    return _event(proposal, "failed", status=status)


def _uninstall_result_event(
    proposal: assistant_proposal.UninstallProposal,
    result: assistant_install.InstallResult | assistant_uninstall.UninstallResult | None,
) -> dict[str, object]:
    if (
        isinstance(result, assistant_uninstall.UninstallResult)
        and 200 <= result.status < 300
        and result.uninstalled is not None
    ):
        return _event(
            proposal,
            "uninstalled",
            team_id=proposal.team_id,
            uninstalled=result.uninstalled,
        )
    status = result.status if result is not None and 400 <= result.status <= 599 else 502
    return _event(proposal, "failed", status=status)


async def _dispatch(
    websocket: WebSocket,
    connection: Connection,
    proposal: assistant_proposal.Proposal,
    send_event: SendEvent,
) -> None:
    state = "uninstalling" if isinstance(proposal, assistant_proposal.UninstallProposal) else "installing"
    if not await send_event(websocket, _event(proposal, state)):
        connection.closed = True
        return
    try:
        future = submit_in_context(_LIFECYCLE_EXECUTOR, _execute, proposal)
    except ExecutorSaturatedError:
        await send_event(websocket, _event(proposal, "failed", status=429))
        return
    operation = Operation(proposal=proposal, future=future)
    connection.lifecycle = operation
    operation.delivery = asyncio.create_task(_deliver(websocket, connection, operation, send_event))


def _install_then_label(proposal: assistant_proposal.InstallProposal) -> assistant_install.InstallResult:
    result = assistant_install.install(proposal)
    if result.installed is None or not 200 <= result.status < 300 or proposal.language_exemplar is None:
        return result
    with contextlib.suppress(Exception):
        response = local.installed_action_labels(
            proposal.team_id,
            proposal.assistant.assistant_id,
            proposal.language_exemplar,
        )
        labels = assistant_install.action_labels(response, proposal)
        if labels is not None:
            return replace(result, labels=labels)
    return result


def _execute(
    proposal: assistant_proposal.Proposal,
) -> assistant_install.InstallResult | assistant_uninstall.UninstallResult:
    if isinstance(proposal, assistant_proposal.UninstallProposal):
        return assistant_uninstall.uninstall(proposal)
    return _install_then_label(proposal)


async def resolve(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    payload: dict[str, object],
    send_event: SendEvent,
) -> bool:
    """Resolve one pending proposal before ordinary Brain dispatch."""
    proposal = connection.lifecycle_proposal
    if proposal is None:
        return False
    if payload["files"] != []:
        decision = "ambiguous"
    elif isinstance(proposal, assistant_proposal.UninstallProposal):
        decision = assistant_proposal.classify_uninstall_confirmation(payload["message"])
    else:
        decision = assistant_proposal.classify_install_confirmation(payload["message"])
    if not proposal.valid_for(team_id, monotonic()):
        connection.lifecycle_proposal = None
        if decision != "ambiguous":
            await send_event(websocket, _event(proposal, "expired"))
            return True
        return False
    if decision == "confirm":
        connection.lifecycle_proposal = None
        await _dispatch(websocket, connection, proposal, send_event)
        return True
    if decision == "cancel":
        connection.lifecycle_proposal = None
        await send_event(websocket, _event(proposal, "cancelled"))
        return True
    connection.lifecycle_proposal = None
    return False


async def close(connection: Connection) -> None:
    """Destroy socket authority and stop observing any admitted lifecycle result."""
    connection.lifecycle_proposal = None
    operation = connection.lifecycle
    if operation is None:
        return
    operation.future.cancel()
    if operation.delivery is not None:
        operation.delivery.cancel()
        await asyncio.gather(operation.delivery, return_exceptions=True)
