"""Chat work under the Space's chat gate (ADR-0119): wait for a slot, run, and say where it waits meanwhile."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping

from chat.connection import Connection, Turn
from chat.projection import error_terminal
from fastapi import WebSocket
from team import bridge as team_bridge

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


async def authorized(websocket: WebSocket) -> None:
    """Before the operation starts after waiting: the authority it was admitted under is still current (ADR-0119)."""
    run = websocket.run if isinstance(websocket, Observed) else None
    authority = getattr(run, "authority", None)
    if authority is not None and not await authority.current():
        raise AuthorityEndedError("the session ended while the operation waited")


def position(websocket: WebSocket) -> chat_gate.Position:
    """Tell the pages watching the run where its operation waits, or that it runs."""
    run = websocket.run if isinstance(websocket, Observed) else None

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
    except chat_gate.QueueFullError:
        await finish(websocket, connection, turn, error_terminal(429, "the chat queue is full"))
    except AuthorityEndedError:
        await finish(websocket, connection, turn, error_terminal(401, "the session ended before the turn could start"))
    except LimitUnavailableError:
        await finish(websocket, connection, turn, error_terminal(503, "the Space chat limit is unavailable"))
    finally:
        turn.slot = None
