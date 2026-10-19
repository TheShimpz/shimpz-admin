"""Chat work under the Space's chat gate (ADR-0119): wait for a slot, run, and say where it waits meanwhile."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping

from chat.connection import Connection, Turn
from chat.projection import error_terminal
from fastapi import WebSocket
from team import bridge as team_bridge
from team.transport import TeamResponse

from chat import gate as chat_gate

FinishTurn = Callable[[WebSocket, Connection, Turn, Mapping[str, object]], Awaitable[None]]


class Observed:
    """What a run's delivery writes to, which can say where the run's operation waits."""

    run: object


class LimitUnavailableError(RuntimeError):
    """Team did not answer the Space's chat limit."""


async def read_limit() -> int:
    """Team's current chat limit, read under the waiting operation's own authority."""
    response = await asyncio.to_thread(team_bridge.chat_limit)
    if response.status != 200:
        raise LimitUnavailableError("the Space chat limit is unavailable")
    return response.body["limit"]


class AuthorityEndedError(RuntimeError):
    """The session the operation was admitted under ended while it waited."""


# Why the gate let an operation not start, as the terminal its page is told.
REFUSED = (chat_gate.QueueFullError, LimitUnavailableError, AuthorityEndedError)


def refusal(error: Exception) -> dict[str, object]:
    if isinstance(error, chat_gate.QueueFullError):
        return error_terminal(429, "the chat queue is full")
    if isinstance(error, LimitUnavailableError):
        return error_terminal(503, "the Space chat limit is unavailable")
    return error_terminal(401, "the session ended before the work could start")


def space_busy(response: object) -> bool:
    """Whether Team refused the work only because the Space runs as many chat turns as its limit."""
    return isinstance(response, TeamResponse) and response.status == 429 and response.body == {"code": "space-busy"}


def _run(websocket: WebSocket) -> object | None:
    return websocket.run if isinstance(websocket, Observed) else None


async def authorized(websocket: WebSocket) -> None:
    """Before the operation starts after waiting: the authority it was admitted under is still current (ADR-0119)."""
    authority = getattr(_run(websocket), "authority", None)
    if authority is not None and not await authority.current():
        raise AuthorityEndedError("the session ended while the operation waited")


def position(websocket: WebSocket) -> chat_gate.Position:
    """Tell the pages watching the run where its operation waits, or that it runs."""
    run = _run(websocket)

    def tell(place: int | None) -> None:
        # Only a change is told: an operation that never waited starts without a word.
        if run is not None and run.position != place:
            run.position = place
            run.publish(run.snapshot())

    return tell


async def run(
    websocket: WebSocket,
    connection: Connection,
    turn: Turn,
    work: Callable[[], Awaitable[None]],
    finish: FinishTurn,
) -> None:
    """Run one turn's work under a slot of the Space's chat gate, waiting for it first."""
    try:
        async with chat_gate.GATE.slot(position(websocket), read_limit) as held:
            turn.slot = held
            await authorized(websocket)
            await work()
    except REFUSED as error:
        await finish(websocket, connection, turn, refusal(error))
    finally:
        turn.slot = None
