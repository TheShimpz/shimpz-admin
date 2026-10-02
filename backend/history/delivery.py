"""Local-only commit boundary for chat presentation events."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping

from chat.executor import BoundedThreadPoolExecutor, submit_in_context
from history import context, store
from team import bridge as team

log = logging.getLogger("shimpz-admin")
_enabled = False
# Admission holds the lifecycle lock across a synchronous Team lookup, so it runs on its own small lane: a slow Team
# response saturates only this lane, never the shared default executor that authentication also depends on.
_ADMISSION = BoundedThreadPoolExecutor(max_workers=1, max_outstanding=4, thread_name_prefix="shimpz-history-admit")


def configure(profile: str) -> None:
    global _enabled
    if profile not in {"local", "hosted"}:
        raise ValueError("Admin history profile is invalid")
    _enabled = profile == "local"


def _append_live_user(team_id: str, turn_id: str, message: object) -> bool:
    # Team deletion and Space reset hold the lifecycle lock across their Team call and transcript cleanup, so a user
    # row written here either precedes that cleanup or finds the Team gone: it never survives a completed deletion.
    with store.LIFECYCLE_LOCK:
        if isinstance(team.resolve_team_name(team_id), team.TeamResponse):
            raise store.HistoryUnavailableError("the Team is no longer available")
        return store.append_user(team_id, turn_id, message)


async def admit(team_id: str, message: object) -> str | None:
    if not _enabled:
        return None
    turn_id = store.new_turn_id()
    # A saturated lane raises ExecutorSaturatedError here, before any durable write.
    future = submit_in_context(_ADMISSION, _append_live_user, team_id, turn_id, message)
    committed = await asyncio.wrap_future(future)
    if not committed:
        raise store.HistoryUnavailableError("chat history user entry was not committed")
    return turn_id


async def conversation(team_id: str, turn_id: str | None) -> tuple[context.Entry, ...]:
    if not _enabled:
        return ()
    if turn_id is None:
        raise store.HistoryUnavailableError("chat history conversation anchor is unavailable")
    return await asyncio.to_thread(store.conversation, team_id, turn_id)


async def terminal(
    team_id: object,
    turn_id: str | None,
    event: Mapping[str, object],
    *,
    finish_history: bool = False,
) -> None:
    if turn_id is None:
        return
    if event.get("type") == "done":
        committed = await asyncio.to_thread(store.append_reply, team_id, turn_id, event)
        if not committed:
            raise store.HistoryUnavailableError("chat history reply was not committed")
        return
    if finish_history:
        await asyncio.to_thread(store.finish_resumable_turn, turn_id)


async def challenge(team_id: str, turn_id: str | None) -> None:
    if turn_id is None:
        return
    committed = await asyncio.to_thread(store.bind_resumable_turn, team_id, turn_id)
    if not committed:
        raise store.HistoryUnavailableError("chat history challenge was not bound")


async def resume(team_id: str) -> str | None:
    if not _enabled:
        return None
    turn_id = await asyncio.to_thread(store.resumable_turn, team_id)
    if turn_id is None:
        raise store.HistoryUnavailableError("chat history resumable turn is unavailable")
    return turn_id


async def observe(team_id: str) -> str | None:
    if not _enabled:
        return None
    return await asyncio.to_thread(store.resumable_turn, team_id)


async def resume_exact(team_id: str, turn_id: str | None) -> str | None:
    if not _enabled:
        return None
    if turn_id is None or await asyncio.to_thread(store.resumable_turn, team_id) != turn_id:
        raise store.HistoryUnavailableError("chat history resumable turn is unavailable")
    return turn_id


async def abandon(turn_id: str | None) -> None:
    if _enabled and turn_id is not None:
        await asyncio.to_thread(store.finish_resumable_turn, turn_id)


async def resumed_terminal(turn_id: str | None, event: Mapping[str, object]) -> None:
    if not _enabled:
        return
    if turn_id is None:
        raise store.HistoryUnavailableError("chat history resumable turn is unavailable")
    if event.get("type") == "done":
        team_id = event.get("team_id")
        committed = await asyncio.to_thread(store.append_reply, team_id, turn_id, event)
        if not committed:
            raise store.HistoryUnavailableError("chat history resumed reply was not committed")
        return
    await asyncio.to_thread(store.finish_resumable_turn, turn_id)


async def guidance(team_id: str, turn_id: str | None, code: str, reply: str) -> None:
    if turn_id is None:
        return
    committed = await asyncio.to_thread(store.append_guidance, team_id, turn_id, code, reply)
    if not committed:
        raise store.HistoryUnavailableError("chat history guidance was not committed")
