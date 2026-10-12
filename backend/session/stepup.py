"""The Supervisor's two-step operations over the session socket (ADR-0114 decision 6, ADR-0051).

A confirmation starts with the Supervisor password, within sign-in's own limiter, lockout, and journal, and with the
socket's bound Origin. Its one-use ticket keeps every binding it always had (the purpose, the exact operation and its
Team or Routine subject, the Origin, the factor generation, its 180-second expiry, and single consumption) and is bound
to the socket and its session too: the socket keeps it, the page never holds it, and it dies with either. The second
factor spends it on a lane worker; the session, the socket, and its Origin are checked again after the factor and
immediately before the operation is dispatched.
"""

from collections.abc import Callable
from typing import TYPE_CHECKING

from fastapi import HTTPException
from session import lane, registry, topics
from signin import local_auth

if TYPE_CHECKING:
    from session.socket import SessionSocket

Answer = lane.Answer
Dispatch = Callable[[local_auth.Asker], object]


def _asker(socket: SessionSocket) -> local_auth.Asker:
    return local_auth.Asker(socket.origin, socket.cookies.get(socket.gate.cookie, ""), socket.step_up)


def _offer(socket: SessionSocket, subject: str) -> Answer:
    """On the lane worker: issue the operation's ticket, which the socket keeps, and offer its second factor.

    A socket keeps one pending confirmation: one begun again replaces the one before it, which is spent at once. A
    ticket issued as the socket closed is revoked here, since the socket's own revocation may have run first.
    """
    confirmations = socket.gate.confirmations
    try:
        offer, token = local_auth.offer_operation(_asker(socket), confirmations, subject)
    except local_auth.OperationRefusedError as exc:
        return local_auth.operation_refusal(exc)
    earlier, socket.ticket = socket.ticket, token
    local_auth.discard_operation(earlier, confirmations)
    if not registry.REGISTRY.live(socket.step_up):
        confirmations.ticket_store.revoke(socket.step_up)
    return 202, offer


async def begin(socket: SessionSocket, subject: str, body: dict[str, object]) -> Answer:
    """Check the password for one exact operation, then offer its second factor once the socket is still current."""
    try:
        password = local_auth.operation_password(body)
        await local_auth.verify_operation_password(_asker(socket), socket.gate.confirmations, password)
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}
    except local_auth.OperationRefusedError as exc:
        return local_auth.operation_refusal(exc)
    return await lane.run(socket, _offer, socket, subject)


def _current(socket: SessionSocket) -> bool:
    """The socket is still open in its session, and its Origin and session are still current (on the lane worker)."""
    return registry.REGISTRY.live(socket.step_up) and lane.current(socket)


def _complete(socket: SessionSocket, subject: str, body: dict[str, object], dispatch: Dispatch) -> object:
    """On the lane worker: spend the socket's one ticket on one second factor, then dispatch the operation.

    The ticket is spent whatever the second factor, and also when it was begun for another operation.
    """
    method, value = local_auth.operation_factor(body)
    token, socket.ticket = socket.ticket, ""
    asker = _asker(socket)
    try:
        return local_auth.confirm_operation(
            asker,
            socket.gate.confirmations,
            subject,
            local_auth.Confirmation(token, method, value),
            lambda: _current(socket),
            lambda: dispatch(asker),
        )
    except local_auth.OperationRefusedError as exc:
        return local_auth.operation_refusal(exc)


async def complete(socket: SessionSocket, subject: str, body: dict[str, object], dispatch: Dispatch) -> Answer:
    return await lane.run(socket, _complete, socket, subject, body, dispatch)


# The Supervisor's own security: recovery codes and the signing key, each confirmed.


def _security(result: Answer) -> Answer:
    """A security change Admin completed changes the session's sign-in security summary (on the lane worker)."""
    if 200 <= result[0] < 300:
        topics.changed("security/summary")
    return result


async def recovery_codes_confirmation(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await begin(socket, local_auth.RECOVERY_CODES_SUBJECT, params["body"])


async def recovery_codes_replace(socket: SessionSocket, params: dict[str, object]) -> Answer:
    def replace(asker: local_auth.Asker) -> Answer:
        return _security(local_auth.regenerate_recovery_codes(asker.origin, socket.gate.confirmations))

    return await complete(socket, local_auth.RECOVERY_CODES_SUBJECT, params["body"], replace)


async def supervisor_key_confirmation(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await begin(socket, local_auth.SUPERVISOR_KEY_SUBJECT, params["body"])


async def supervisor_key_rotate(socket: SessionSocket, params: dict[str, object]) -> Answer:
    retry = getattr(socket.websocket.app.state, "supervisor_key_recovery", None)

    def rotate(asker: local_auth.Asker) -> Answer:
        return _security(local_auth.rotate_supervisor_key(asker, retry))

    return await complete(socket, local_auth.SUPERVISOR_KEY_SUBJECT, params["body"], rotate)
