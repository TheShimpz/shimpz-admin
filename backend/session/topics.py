"""Invalidation topics of the Admin session socket (ADR-0114).

A topic names state a screen shows; a change only says that the state changed, never what it is now. Each topic has a
monotonic revision within this process's epoch, so a read can say which revision it reflects and a client recognizes a
stale one. Any thread may raise a change: listeners schedule their own delivery.
"""

import secrets
import threading
from collections.abc import Callable

from protocol.socket.v1 import frames

# One Admin process instance; a new epoch invalidates every topic a client holds.
EPOCH = secrets.token_hex(16)

Listener = Callable[[str, int], None]

_lock = threading.Lock()
_revisions: dict[str, int] = {}
_listeners: set[Listener] = set()


def revision(topic: str) -> int:
    """The topic's current revision; a topic that never changed is at revision 0."""
    with _lock:
        return _revisions.get(topic, 0)


def changed(topic: str) -> int:
    """Advance one topic's revision and tell every listener, returning the new revision."""
    if not frames.is_topic(topic):
        raise ValueError("invalid session topic")
    with _lock:
        current = _revisions.get(topic, 0) + 1
        _revisions[topic] = current
        listeners = tuple(_listeners)
    for listener in listeners:
        listener(topic, current)
    return current


def team_changed(team_id: str, *names: str) -> None:
    """Raise each named topic of one Team, such as ``history`` and ``routines``."""
    for name in names:
        changed(f"team/{team_id}/{name}")


def listen(listener: Listener) -> None:
    with _lock:
        _listeners.add(listener)


def forget(listener: Listener) -> None:
    with _lock:
        _listeners.discard(listener)
