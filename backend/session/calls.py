"""Admitting and answering one session socket call (ADR-0114 decision 3).

A call is counted against its session's budgets, its request body against its operation's own bound, and it runs under
the Supervisor authority bound again from the current signing identity, never kept from the handshake. A read's result
carries the revision of the topic it reflects, taken before the read, so a change that lands meanwhile is never
mistaken for being seen. Every call ends in exactly one result, unless its socket closed first.
"""

import contextlib
import logging
from typing import TYPE_CHECKING

import state
import supervisor
from protocol.socket.v1 import frames
from session import budget, lane, methods, topics
from session.outbound import OutboundOverflowError
from signin import audit, auth
from team import transport

if TYPE_CHECKING:
    from session.socket import SessionSocket

log = logging.getLogger("shimpz-admin")

UNAVAILABLE_AUTHORITY = (503, {"detail": "Supervisor authority is unavailable"})
# A stored key record Admin did not write: fixed words with the one remedy, never the store's own details.
CREDENTIAL_RECORD_INVALID = (
    503,
    {
        "code": "credential-record-invalid",
        "detail": "A stored key record is invalid; reset the Space with shimpz reset",
    },
)
BODY_TOO_LARGE = (413, {"detail": "request body too large"})


def admission(socket: SessionSocket, method: str) -> str | None:
    """Count one call against its session's budgets, or the reason it is refused."""
    if not budget.CALL_BUDGET.admit(socket.session):
        return "session call budget reached"
    if method in frames.SOCKET_STATE_METHODS and not budget.SOCKET_CHANGE_BUDGET.admit(socket.session):
        return "session change budget reached"
    return None


def _oversized(method: str, params: dict[str, object]) -> bool:
    """A request body larger than its operation's bound, which its route refused before reading it whole."""
    limit = frames.BODY_BYTES.get(method)
    return limit is not None and frames.body_bytes(params["body"]) > limit


async def _dispatch(socket: SessionSocket, call_id: str, method: str, params: dict[str, object]) -> lane.Answer:
    """Run one method under the current Supervisor authority, answering its failures as the HTTP gate does."""
    try:
        # Every operation reaches Admin's or Team's state under the current Supervisor authority; changing what the
        # socket itself holds needs none.
        local = method in frames.SOCKET_STATE_METHODS
        with contextlib.nullcontext() if local else socket.gate.request_scope(socket.cookies):
            return await methods.dispatch(socket, call_id, method, params)
    except lane.RefusedError:
        raise
    except transport.TeamRequestError, supervisor.SupervisorAuthorityError:
        return UNAVAILABLE_AUTHORITY
    except auth.PasswordRecordError:
        return 503, {"code": "password-recovery-required", "detail": "Supervisor password recovery is required"}
    except state.CredentialRecordError:
        return CREDENTIAL_RECORD_INVALID
    except audit.AuditUnavailableError:
        return 503, {"detail": "Supervisor authentication audit is unavailable"}
    except Exception:
        # Every call ends in exactly one result: an unexpected failure is the server error HTTP would answer.
        log.exception("session socket call %s failed", method)
        return 500, {"detail": "Internal Server Error"}


async def run(socket: SessionSocket, call_id: str, method: str, params: dict[str, object]) -> None:
    """Answer one call with exactly one result; a result too large for one frame is answered as a failure.

    A read checks its socket again on the lane worker that runs it; any other call checks it as its task starts too.
    """
    if method not in frames.READ_TOPICS and not await socket.authorized():
        return
    topic = frames.READ_TOPICS[method](params) if method in frames.READ_TOPICS else None
    revision = (topic, topics.EPOCH, topics.revision(topic)) if topic is not None and frames.is_topic(topic) else None
    if _oversized(method, params):
        status, body = BODY_TOO_LARGE
    else:
        try:
            status, body = await _dispatch(socket, call_id, method, params)
        except lane.RefusedError:
            return
    frame = frames.result(call_id, status, body, revision if 200 <= status < 300 else None)
    try:
        frames.encode(frame)
    except ValueError:
        log.warning("session socket result for %s exceeds the frame bound", method)
        frame = frames.result(call_id, 502, {"detail": "the result exceeds the session frame bound"})
    try:
        socket.send(frame)
    except OutboundOverflowError, RuntimeError:
        return
