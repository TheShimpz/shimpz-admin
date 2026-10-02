"""In-memory state for one admitted Admin chat connection."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading
import time
from dataclasses import dataclass, field

from chat.assistant_proposal import AssistantReference, UninstallProposal
from history import context as history_context

from chat import lifecycle
from protocol.http.v1 import payload as team_contract

# The sent messages whose identity a retry, resend, or reconnect may still reuse, across every connection.
MAX_SENT_REQUESTS = 1024
SENT_REQUEST_FIELDS = frozenset({"nonce", "resend"})


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


def canonical_sent_request(value: object) -> dict[str, object] | None:
    """The browser's name for one logical send: a 32-hex nonce it keeps across retries, and whether this is a resend."""
    if not isinstance(value, dict) or set(value) != SENT_REQUEST_FIELDS or type(value["resend"]) is not bool:
        return None
    nonce = value["nonce"]
    if not isinstance(nonce, str) or team_contract.REQUEST_NONCE_RE.fullmatch(nonce) is None:
        return None
    return {"nonce": nonce, "resend": value["resend"]}


class RequestBook:
    """The identity Admin issued for each logical send (ADR-0092), shared by every connection of this process.

    A first send issues ``issued_at`` once for the browser's nonce; a retry, resend, or reconnect that names the same
    nonce and the same message reuses it, exactly while Team's own freshness predicate admits it. A resend that is no
    longer fresh, names an unknown nonce, or carries another message is refused, so an expired retry is never turned
    into a new grant; a first send never reuses a nonce.
    """

    def __init__(self, clock=time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._sent: dict[tuple[str, str], tuple[str, int]] = {}

    def identity(self, team_id: str, sent: dict[str, object], payload: dict[str, object]) -> dict[str, object] | None:
        now = int(self._clock())
        key = (team_id, sent["nonce"])
        commitment = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._sent = {
                name: value for name, value in self._sent.items() if team_contract.request_identity_fresh(value[1], now)
            }
            known = self._sent.get(key)
            if sent["resend"]:
                if known is None or known[0] != commitment:
                    return None
                return {"issued_at": known[1], "nonce": sent["nonce"]}
            if known is not None:
                return None
            if len(self._sent) >= MAX_SENT_REQUESTS:
                # The oldest identity gives way; a resend of it is then refused, never renewed.
                del self._sent[min(self._sent, key=lambda name: self._sent[name][1])]
            self._sent[key] = (commitment, now)
        return {"issued_at": now, "nonce": sent["nonce"]}


REQUESTS = RequestBook()


def forget_challenge(connection: Connection) -> None:
    connection.pending_challenge_id = None
    connection.pending_challenge_type = None
    connection.pending_human_request = None
