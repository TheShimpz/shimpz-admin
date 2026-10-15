"""The process-wide registry of open Admin session sockets (ADR-0114 decision 5).

Every open socket is registered under its session's digest. When sessions stop being tracked (logout and every other
rotation of the session secret, factor suspension, capacity eviction, idling out), the registry closes their sockets
at once with 4401, the close that means signed out. Absolute and idle expiry of a quiet socket are each socket's own
timer.
"""

import contextlib
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from mfa import tickets
from protocol.socket.v1 import frames
from signin import auth

SIGNED_OUT = 4401


async def session_status(
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    cookies: Mapping[str, str],
) -> str:
    """`active`, `invalid`, or `unavailable` when the session check itself failed."""
    status = "unavailable"
    with contextlib.suppress(Exception):
        status = "active" if await session_ok(cookies) is True else "invalid"
    return status


@dataclass(eq=False, slots=True)
class Handle:
    """One registered socket: its session, a thread-safe way to end it, and what its session's authority allows.

    `current` checks the session without counting as Supervisor activity, and `scope` binds the current Supervisor
    authority of the session to downstream Team calls.
    """

    session: str
    socket: str
    cookies: dict[str, str] = field(repr=False)
    end: Callable[[int], None] = field(repr=False)
    subscribed: Callable[[str], bool] = field(repr=False)
    current: Callable[[Mapping[str, str]], Awaitable[bool]] = field(repr=False)
    scope: Callable[[], contextlib.AbstractContextManager[None]] = field(repr=False)
    # Tells the socket, from any thread, that its session's idle time restarted.
    renewed: Callable[[], None] = field(repr=False)


class Registry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handles: dict[str, set[Handle]] = {}

    def add(self, handle: Handle) -> bool:
        """Register one socket, or refuse it when its session already holds as many as it may."""
        with self._lock:
            handles = self._handles.setdefault(handle.session, set())
            if len(handles) >= frames.MAX_SOCKETS_PER_SESSION:
                return False
            handles.add(handle)
            return True

    def remove(self, handle: Handle) -> None:
        with self._lock:
            handles = self._handles.get(handle.session)
            if handles is None:
                return
            handles.discard(handle)
            if not handles:
                del self._handles[handle.session]

    def live(self, binding: tickets.Binding) -> bool:
        """Whether the socket a step-up ticket is bound to is still open in its session.

        A confirmation checks this after its second factor and immediately before it dispatches, so a socket that
        closed meanwhile never reaches the operation, even with a ticket it already spent.
        """
        with self._lock:
            return any(handle.socket == binding.socket for handle in self._handles.get(binding.session, ()))

    def handles(self) -> tuple[Handle, ...]:
        with self._lock:
            return tuple(handle for handles in self._handles.values() for handle in handles)

    def renewed(self, session: str) -> None:
        """Tell every socket of the session that its idle time restarted, so each tab times its warning anew."""
        with self._lock:
            handles = tuple(self._handles.get(session, ()))
        for handle in handles:
            handle.renewed()

    def end_sessions(self, sessions: frozenset[str] | None) -> None:
        """Close every socket of these sessions, or of every session when None, as signed out."""
        with self._lock:
            ended = [
                handle
                for session, handles in self._handles.items()
                if sessions is None or session in sessions
                for handle in handles
            ]
        for handle in ended:
            handle.end(SIGNED_OUT)


REGISTRY = Registry()
auth.SESSIONS.listen(REGISTRY.end_sessions)
