"""In-memory state for one admitted Admin chat connection."""

import asyncio
import concurrent.futures
import secrets
import threading
import time
from dataclasses import dataclass, field

from chat.assistant_proposal import AssistantReference, UninstallProposal
from chat.lifecycle import Operation
from history import context as history_context


@dataclass(slots=True)
class Turn:
    future: concurrent.futures.Future | None
    operation: str
    progress: asyncio.Queue[dict[str, object]] | None = None
    delivery: asyncio.Task | None = None
    stop_task: asyncio.Task | None = None
    stop_requested: bool = False
    terminal_sent: bool = False
    # The interface language of the turn's lifecycle guidance and proposals (ADR-0090).
    locale: str | None = None
    lifecycle_stop: threading.Event | None = field(default=None, repr=False)
    history_id: str | None = field(default=None, repr=False)
    # Committed presentation history before this turn's user row, captured once and sent with its Team turn start.
    conversation: tuple[history_context.Entry, ...] = field(default=(), repr=False)
    # The identity Team binds a Routine change of this turn to (ADR-0092), issued once per sent message.
    request: dict[str, object] | None = field(default=None, repr=False)
    # The turn's hold on the Space's chat gate while it runs (ADR-0119).
    slot: object | None = field(default=None, repr=False)
    # The status of a Stop sent for it whose outcome Team did not confirm.
    stop_unconfirmed: int | None = None


@dataclass(slots=True)
class Receipt:
    """The Team progress a channel delivered of one logical turn, which its reply keeps (ADR-0082).

    The page lists these steps under the reply. Each delivery restarts its sequence, so every event keeps the delivery
    it came in; a continuation after a human or Integration request adds its delivery to its history turn's receipt.
    """

    turn_id: str | None = None
    deliveries: int = 0
    events: list[dict[str, object]] = field(default_factory=list)


@dataclass(slots=True)
class Connection:
    # The Team whose chat this is; every terminal it persists is that Team's.
    team_id: str | None = None
    active: Turn | None = None
    pending_challenge_id: str | None = None
    pending_challenge_type: str | None = None
    pending_human_request: dict[str, object] | None = None
    sync_task: asyncio.Task | None = None
    sync_terminal_sent: bool = False
    # A human or Integration continuation Team executes now (ADR-0119): ending the run stops it there too, and the Team
    # is released only once it ended.
    continuing: bool = False
    continuation: concurrent.futures.Future | None = field(default=None, repr=False)
    lifecycle_proposal: UninstallProposal | None = None
    lifecycle: Operation | None = None
    assistant_reference: AssistantReference | None = None
    closed: bool = False
    admitted_history_id: str | None = field(default=None, repr=False)
    pending_history_id: str | None = field(default=None, repr=False)
    receipt: Receipt = field(default_factory=Receipt, repr=False)


@dataclass(frozen=True, slots=True)
class SyncSnapshot:
    challenge_type: str
    pending: object
    resumed: object | None = None
    # The pending Integration challenge whose granted continuation resumes under the Space's chat gate.
    resume: str | None = None


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


def request_identity(now: int | None = None) -> dict[str, object]:
    """A fresh identity for one send (ADR-0092): its issue instant and a nonce. A send is never resent as itself."""
    return {"issued_at": int(time.time()) if now is None else now, "nonce": secrets.token_hex(16)}


def forget_challenge(connection: Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None
