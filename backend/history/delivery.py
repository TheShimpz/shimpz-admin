"""Local-only commit boundary for chat presentation events."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping

from history import store

log = logging.getLogger("shimpz-admin")
_enabled = False


def configure(profile: str) -> None:
    global _enabled
    if profile not in {"local", "hosted"}:
        raise ValueError("Admin history profile is invalid")
    _enabled = profile == "local"


async def admit(team_id: str, message: object) -> str | None:
    if not _enabled:
        return None
    turn_id = store.new_turn_id()
    committed = await asyncio.to_thread(store.append_user, team_id, turn_id, message)
    if not committed:
        raise store.HistoryUnavailableError("chat history user entry was not committed")
    return turn_id


async def terminal(
    team_id: object,
    turn_id: str | None,
    event: Mapping[str, object],
) -> None:
    if turn_id is None or event.get("type") != "done":
        return
    await asyncio.to_thread(store.append_reply, team_id, turn_id, event)


async def guidance(team_id: str, turn_id: str | None, code: str) -> None:
    if turn_id is None:
        return
    committed = await asyncio.to_thread(store.append_guidance, team_id, turn_id, code)
    if not committed:
        raise store.HistoryUnavailableError("chat history guidance was not committed")
