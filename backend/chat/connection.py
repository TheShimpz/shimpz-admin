"""In-memory state for one admitted Admin chat connection."""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from dataclasses import dataclass, field

from chat.assistant_proposal import AssistantReference, UninstallProposal
from history import context as history_context

from chat import lifecycle
from protocol.http.v1 import payload as team_contract

# Admin's key for the sealed identity of each logical send. It lives only as long as this process: after a restart
# no earlier seal verifies, so every earlier resend is refused rather than renewed.
_SEAL_KEY = secrets.token_bytes(32)
SEND_SEAL_RE = re.compile(r"([1-9][0-9]{0,11})\.([0-9a-f]{32})\.([0-9a-f]{64})\Z")


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


def valid_sent_request(value: object) -> bool:
    """A frame's ``request``: null for a first send, or exactly the seal Admin gave that send, for a resend."""
    return value is None or (isinstance(value, str) and SEND_SEAL_RE.fullmatch(value) is not None)


def _commitment(team_id: str, payload: dict[str, object], issued_at: int, nonce: str) -> bytes:
    message = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(["shimpz-chat-send-v1", team_id, message, issued_at, nonce], separators=(",", ":")).encode()


def request_identity(
    team_id: str, seal: str | None, payload: dict[str, object], now: int | None = None
) -> tuple[dict[str, object], str] | None:
    """The identity of one logical send (ADR-0092) and the seal the browser keeps for resending it, or None.

    A first send names no identity and always receives a fresh one, so no frame can claim another send's grant. A
    resend returns the seal Admin issued: it verifies only for the same Team and message, and only while Team's own
    freshness predicate admits its original issue instant. A seal that expired, was altered, belongs to another
    message, or predates this process is refused, so an expired retry is never renewed. Nothing is remembered.
    """
    now = int(time.time()) if now is None else now
    if seal is None:
        issued_at, nonce = now, secrets.token_hex(16)
    else:
        match = SEND_SEAL_RE.fullmatch(seal)
        if match is None:
            return None
        issued_at, nonce = int(match[1]), match[2]
        expected = hmac.new(_SEAL_KEY, _commitment(team_id, payload, issued_at, nonce), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, match[3]) or not team_contract.request_identity_fresh(issued_at, now):
            return None
    tag = hmac.new(_SEAL_KEY, _commitment(team_id, payload, issued_at, nonce), hashlib.sha256).hexdigest()
    return {"issued_at": issued_at, "nonce": nonce}, f"{issued_at}.{nonce}.{tag}"


def forget_challenge(connection: Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None
