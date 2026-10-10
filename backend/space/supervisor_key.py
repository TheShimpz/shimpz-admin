"""Rotating the Supervisor's signing key under the key Team pins now (ADR-0051, ADR-0017).

Team verifies every Supervisor assertion under its own pin of the Supervisor key and replaces that pin only on
`POST /v1/space/supervisor-key`, signed by the pinned key. Admin first saves the new key durably beside the current
one, then asks Team to switch. Team's answer decides: on the switch the new key becomes current, is published, and the
earlier one is dropped; on a definite refusal the pending key is dropped and the current one stays. When Team cannot
be reached the pending key is kept, and Admin retries the same rotation (after a restart too), first signed by the
earlier key and, when Team refuses that one because it already switched, signed by the new one.
"""

import base64
import enum
import hashlib
import logging
import secrets
import threading

import state
import supervisor
from signin import audit
from team import transport

ROTATION_PATH = "/v1/space/supervisor-key"
RETRY_SECONDS = 30.0
log = logging.getLogger("shimpz-admin")
_LOCK = threading.Lock()


class Outcome(enum.Enum):
    NONE = "none"
    ROTATED = "rotated"
    ABANDONED = "abandoned"
    PENDING = "pending"


def _public_key(identity: supervisor.LocalIdentity) -> str:
    return base64.urlsafe_b64encode(supervisor.public_key_raw(identity)).rstrip(b"=").decode("ascii")


def _ask_team(signer: supervisor.LocalIdentity, authority: str, pending: supervisor.LocalIdentity):
    with transport.supervisor_session(authority, local_identity=signer):
        return transport._call("POST", ROTATION_PATH, {"public_key": _public_key(pending)})


def _switched(response: transport.TeamResponse, pending: supervisor.LocalIdentity) -> bool | None:
    """True when Team pins the pending key; False on a definite refusal; None when Team's answer decides nothing."""
    if response.status == 200:
        body = response.body
        expected = {"rotated": True, "key_sha256": hashlib.sha256(supervisor.public_key_raw(pending)).hexdigest()}
        if {key: value for key, value in body.items() if key != "trace_id"} == expected:
            return True
        # Team switched to some key, but not this one: keep both keys rather than guess which one Team pins.
        log.error("Team answered a Supervisor key rotation for another key")
        return None
    if response.status >= 500:
        return None
    return False


def _adopt(pending: supervisor.LocalIdentity) -> Outcome:
    state.adopt_supervisor_key(pending, journal=lambda _result: audit.record("supervisor-key-rotated", outcome="ok"))
    log.warning("Local Supervisor signing key rotated")
    try:
        supervisor.materialize_public_key(pending)
    except supervisor.SupervisorAuthorityError:
        # Team verifies under its own pin; the published copy is written again on the next start.
        log.warning("Local Supervisor public key could not be published after the rotation")
    return Outcome.ROTATED


def _abandon(pending: supervisor.LocalIdentity) -> Outcome:
    state.abandon_supervisor_key(
        pending, journal=lambda _result: audit.record("supervisor-key-rotation-abandoned", outcome="denied")
    )
    log.warning("Team kept the current Supervisor signing key; the pending key was dropped")
    return Outcome.ABANDONED


def resolve(authority: str | None = None) -> Outcome:
    """Settle the open rotation, if any, with Team's answer; PENDING while Team's answer decides nothing.

    `authority` is the Supervisor session that asked for the rotation; a retry without one (after a restart) signs
    under a fresh one-time value, which Team records only as a digest.
    """
    with _LOCK:
        pending = state.pending_supervisor_key()
        if pending is None:
            return Outcome.NONE
        current = state.local_supervisor()
        session = authority if authority is not None else secrets.token_urlsafe(32)
        first = _ask_team(current, session, pending)
        decided = _switched(first, pending)
        if decided is False and first.status in {403, 409}:
            # Team refuses the earlier key once it pins the new one: the new key's own request shows it.
            decided = _switched(_ask_team(pending, session, pending), pending)
        if decided is None:
            log.warning("Supervisor key rotation is waiting for Team")
            return Outcome.PENDING
        return _adopt(pending) if decided else _abandon(pending)


def rotate(authority: str, origin: str | None) -> Outcome:
    """Save a new key, journaled first, and ask Team to pin it; an open rotation is settled before a new one begins."""
    outcome = resolve(authority)
    if outcome in {Outcome.ROTATED, Outcome.PENDING}:
        return outcome
    current = state.local_supervisor()
    pending = supervisor.LocalIdentity(current.supervisor_id, supervisor.new_identity().private_key_hex)
    state.begin_supervisor_key_rotation(
        pending,
        journal=lambda _result: audit.record("supervisor-key-rotation-started", outcome="ok", origin=origin),
    )
    return resolve(authority)


class Recovery:
    """Retry an open rotation in the background: at start, when woken, and every RETRY_SECONDS while one is open."""

    def __init__(self, interval: float = RETRY_SECONDS) -> None:
        self._interval = interval
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="supervisor-key-recovery", daemon=True)

    def start(self) -> None:
        self._wake.set()
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=5)

    def _loop(self) -> None:
        while True:
            self._wake.wait(self._interval)
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                resolve()
            except Exception:
                # An unreadable store or a refused journal keeps both keys; the next attempt tries again.
                log.exception("Supervisor key rotation retry failed")
