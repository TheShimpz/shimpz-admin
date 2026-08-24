"""Socket-scoped discovery, confirmation, and installation lifecycle."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from chat.executor import BoundedThreadPoolExecutor, ExecutorSaturatedError, submit_in_context
from fastapi import WebSocket
from team import bridge as team

from chat import assistant_install, assistant_proposal, store_catalog

_DISCOVERY_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-discovery",
)
_INSTALL_EXECUTOR = BoundedThreadPoolExecutor(
    max_workers=2,
    max_outstanding=2,
    thread_name_prefix="shimpz-chat-install",
)
_STORE_CATALOG = store_catalog.StoreCatalog()
monotonic = time.monotonic

SendEvent = Callable[[WebSocket, Mapping[str, object]], Awaitable[bool]]


@dataclass(slots=True)
class Operation:
    proposal: assistant_proposal.InstallProposal
    future: concurrent.futures.Future
    delivery: asyncio.Task | None = None


class Connection(Protocol):
    closed: bool
    install_proposal: assistant_proposal.InstallProposal | None
    install: Operation | None


def _assistant_identity(proposal: assistant_proposal.InstallProposal) -> dict[str, object]:
    assistant = proposal.assistant
    return {
        "id": assistant.assistant_id,
        "name": assistant.name,
        "summary": assistant.summary,
        "providers": sorted({item.provider for item in assistant.integrations}),
    }


def _proposal_event(
    proposal: assistant_proposal.InstallProposal,
    terminal: Mapping[str, object],
) -> dict[str, object]:
    return {
        "type": "assistant-install",
        "state": "proposed",
        "proposal_id": proposal.proposal_id,
        "team_id": proposal.team_id,
        "reply": terminal["reply"],
        "expires_in": assistant_proposal.PROPOSAL_TTL_SECONDS,
        "assistant": _assistant_identity(proposal),
    }


def _event(
    proposal: assistant_proposal.InstallProposal,
    state: str,
    **fields: object,
) -> dict[str, object]:
    return {
        "type": "assistant-install",
        "state": state,
        "proposal_id": proposal.proposal_id,
        "assistant_id": proposal.assistant.assistant_id,
        **fields,
    }


def submit_discovery(
    team_id: str,
    payload: dict[str, object],
) -> concurrent.futures.Future | None:
    """Start optional discovery without letting its failure affect ordinary chat."""
    try:
        return submit_in_context(
            _DISCOVERY_EXECUTOR,
            assistant_install.discover,
            team_id,
            payload["message"],
            tuple(payload["assistant_ids"]),
            _STORE_CATALOG,
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
) -> store_catalog.CatalogAssistant | None:
    if future is None:
        return None
    try:
        candidate = await asyncio.wrap_future(future)
    except asyncio.CancelledError:
        raise
    except OSError, RuntimeError, TypeError, ValueError, team.TeamRequestError:
        return None
    return candidate if isinstance(candidate, store_catalog.CatalogAssistant) else None


async def attach_proposal(
    connection: Connection,
    discovery_future: concurrent.futures.Future | None,
    team_id: str,
    event: dict[str, object],
) -> dict[str, object]:
    """Attach one strong candidate to a successful turn without changing failures."""
    if event.get("type") != "done":
        cancel_discovery(discovery_future)
        return event
    candidate = await _await_discovery(discovery_future)
    if candidate is None or connection.install_proposal is not None:
        return event
    try:
        proposal = assistant_proposal.create_proposal(team_id, candidate, now=monotonic())
    except ValueError:
        return event
    connection.install_proposal = proposal
    return _proposal_event(proposal, event)


async def _deliver(
    websocket: WebSocket,
    connection: Connection,
    operation: Operation,
    send_event: SendEvent,
) -> None:
    task = asyncio.current_task()
    try:
        result = assistant_install.InstallResult(502)
        with contextlib.suppress(Exception):
            resolved = await asyncio.wrap_future(operation.future)
            if isinstance(resolved, assistant_install.InstallResult):
                result = resolved
        if connection.closed:
            return
        if result.installed is not None and 200 <= result.status < 300:
            event = _event(
                operation.proposal,
                "installed",
                team_id=operation.proposal.team_id,
                installed=result.installed,
            )
        else:
            status = result.status if 400 <= result.status <= 599 else 502
            event = _event(operation.proposal, "failed", status=status)
        if not await send_event(websocket, event):
            connection.closed = True
    finally:
        if operation.delivery is task and connection.install is operation:
            connection.install = None


async def _dispatch(
    websocket: WebSocket,
    connection: Connection,
    proposal: assistant_proposal.InstallProposal,
    send_event: SendEvent,
) -> None:
    if not await send_event(websocket, _event(proposal, "installing")):
        connection.closed = True
        return
    try:
        future = submit_in_context(_INSTALL_EXECUTOR, assistant_install.install, proposal)
    except ExecutorSaturatedError:
        await send_event(websocket, _event(proposal, "failed", status=429))
        return
    operation = Operation(proposal=proposal, future=future)
    connection.install = operation
    operation.delivery = asyncio.create_task(_deliver(websocket, connection, operation, send_event))


async def resolve(
    websocket: WebSocket,
    connection: Connection,
    team_id: str,
    payload: dict[str, object],
    send_event: SendEvent,
) -> bool:
    """Resolve one pending proposal before ordinary Brain dispatch."""
    proposal = connection.install_proposal
    if proposal is None:
        return False
    decision = assistant_proposal.classify_confirmation(payload["message"]) if payload["files"] == [] else "ambiguous"
    if not proposal.valid_for(team_id, monotonic()):
        connection.install_proposal = None
        if decision != "ambiguous":
            await send_event(websocket, _event(proposal, "expired"))
            return True
        return False
    if decision == "confirm":
        connection.install_proposal = None
        await _dispatch(websocket, connection, proposal, send_event)
        return True
    if decision == "cancel":
        connection.install_proposal = None
        await send_event(websocket, _event(proposal, "cancelled"))
        return True
    return False


async def close(connection: Connection) -> None:
    """Destroy socket authority and stop observing any admitted install result."""
    connection.install_proposal = None
    operation = connection.install
    if operation is None:
        return
    operation.future.cancel()
    if operation.delivery is not None:
        operation.delivery.cancel()
        await asyncio.gather(operation.delivery, return_exceptions=True)
