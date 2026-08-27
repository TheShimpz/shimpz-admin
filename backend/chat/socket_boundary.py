"""Static origin and frame admission primitives for the Admin chat socket."""

from __future__ import annotations

import contextlib
import os
from collections.abc import Awaitable, Callable, Mapping

from fastapi import WebSocket, WebSocketDisconnect

from protocol.http.v1 import websocket as chat_ws_common

MAX_FRAME_BYTES = 128 * 1024
_DEFAULT_ORIGINS = "http://127.0.0.1:7777,http://localhost:7777"
canonical_origin = chat_ws_common.canonical_origin


def configured_origins() -> frozenset[str]:
    configured = os.environ.get("SHIMPZ_ADMIN_ALLOWED_ORIGINS", _DEFAULT_ORIGINS)
    items = [item.strip() for item in configured.split(",")]
    if not items or any(not item or canonical_origin(item) != item for item in items):
        raise RuntimeError("SHIMPZ_ADMIN_ALLOWED_ORIGINS must contain exact HTTP(S) origins")
    return frozenset(items)


async def receive_bounded_json(websocket: WebSocket) -> dict[str, object]:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    return chat_ws_common.decode_bounded_json_frame(message, MAX_FRAME_BYTES)


async def session_status(
    session_ok: Callable[[Mapping[str, str]], Awaitable[bool]],
    cookies: Mapping[str, str],
) -> str:
    status = "unavailable"
    with contextlib.suppress(Exception):
        status = "active" if await session_ok(cookies) is True else "invalid"
    return status
