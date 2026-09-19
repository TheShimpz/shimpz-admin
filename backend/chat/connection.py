"""In-memory state for one admitted Admin chat connection."""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from dataclasses import dataclass, field

from chat import lifecycle
from chat.assistant_proposal import UninstallProposal


@dataclass(slots=True)
class Turn:
    future: concurrent.futures.Future | None
    operation: str
    progress: asyncio.Queue[dict[str, object]] | None = None
    discovery_future: concurrent.futures.Future | None = None
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False
    language_exemplar: str | None = field(default=None, repr=False)
    lifecycle_stop: threading.Event | None = field(default=None, repr=False)
    history_id: str | None = field(default=None, repr=False)


@dataclass(slots=True)
class Connection:
    active: Turn | None = None
    pending_challenge_id: str | None = None
    pending_challenge_type: str | None = None
    pending_human_request: dict[str, object] | None = None
    sync_task: asyncio.Task | None = None
    sync_terminal_sent: bool = False
    lifecycle_proposal: UninstallProposal | None = None
    lifecycle: lifecycle.Operation | None = None
    ignore_idle_stop_once: bool = False
    closed: bool = False
    admitted_history_id: str | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class SyncSnapshot:
    challenge_type: str
    pending: object
    resumed: object | None = None


def remember_challenge(
    connection: Connection,
    challenge: dict[str, object],
    challenge_type: str,
) -> None:
    connection.pending_challenge_id = challenge["challenge_id"]
    connection.pending_challenge_type = challenge_type
    request = challenge.get("request")
    connection.pending_human_request = (
        dict(request) if challenge_type == "human" and isinstance(request, dict) else None
    )


def forget_challenge(connection: Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None
