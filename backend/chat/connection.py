"""In-memory state for one admitted Admin chat connection."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import secrets
import threading
import time
from dataclasses import dataclass, field

from chat.assistant_proposal import AssistantReference, UninstallProposal
from history import context as history_context

from chat import lifecycle
from protocol.http.v1 import payload as team_contract

# A resend reuses its identity only while Team would still admit it, with room left for the turn itself.
REQUEST_REUSE_SECONDS = team_contract.REQUEST_IDENTITY_SECONDS - 300


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
    assistant_reference: AssistantReference | None = None
    ignore_idle_stop_once: bool = False
    closed: bool = False
    admitted_history_id: str | None = field(default=None, repr=False)
    pending_history_id: str | None = field(default=None, repr=False)
    # The last sent message's Team, canonical payload, and request identity, kept so a resend reuses that identity.
    sent_request: tuple[str, str, dict[str, object]] | None = field(default=None, repr=False)


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


def request_identity(connection: Connection, team_id: str, payload: dict[str, object]) -> dict[str, object]:
    """The identity of one sent message: issued once, and kept when the same message is sent again (ADR-0081 resend).

    Team binds it to the Supervisor, the Team incarnation, and the message, so a Routine change the message carries
    commits at most once; a resend after the identity's validity window is a new request.
    """
    now = int(time.time())
    key = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    sent = connection.sent_request
    if sent is not None and sent[:2] == (team_id, key) and now - sent[2]["issued_at"] < REQUEST_REUSE_SECONDS:
        return sent[2]
    identity = {"issued_at": now, "nonce": secrets.token_hex(16)}
    connection.sent_request = (team_id, key, identity)
    return identity


def forget_challenge(connection: Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None
