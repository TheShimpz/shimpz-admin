"""Durable history ownership across paused Team chat gates."""

from __future__ import annotations

import asyncio
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

_Socket = chat_socket_fixtures.Socket


class ChatHistoryGateTests(ChatWebSocketCase):
    def test_stopped_paused_gate_releases_history_for_the_next_gate(self) -> None:
        async def scenario() -> None:
            stopped = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "stopped": True},
            )
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    side_effect=(
                        chat_socket_fixtures.integration_challenge(),
                        chat_socket_fixtures.integration_challenge(),
                    ),
                ),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "connect", "files": [], "assistant_ids": []}
                )
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                first = self.admin_app.chat_history.resumable_turn("team_1")
                self.assertIsNotNone(first)

                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                self.assertIsNone(self.admin_app.chat_history.resumable_turn("team_1"))

                await websocket.send_json(
                    {"type": "chat", "message": "connect again", "files": [], "assistant_ids": []}
                )
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                second = self.admin_app.chat_history.resumable_turn("team_1")
                self.assertIsNotNone(second)
                self.assertNotEqual(first, second)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_unproven_stop_preserves_a_paused_gate_for_retry(self) -> None:
        async def scenario() -> None:
            unavailable = self.chat_socket.local.PublicResponse(503, {"code": "offline"})
            stopped = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "stopped": True},
            )
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=chat_socket_fixtures.integration_challenge(),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "stop",
                    side_effect=(unavailable, stopped),
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "connect", "files": [], "assistant_ids": []}
                )
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                turn_id = self.admin_app.chat_history.resumable_turn("team_1")
                self.assertIsNotNone(turn_id)

                await websocket.send_json({"type": "stop"})
                failure = await websocket.next_json()
                self.assertEqual((failure["type"], failure["status"]), ("error", 503))
                self.assertEqual(self.admin_app.chat_history.resumable_turn("team_1"), turn_id)

                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                self.assertIsNone(self.admin_app.chat_history.resumable_turn("team_1"))
                await websocket.disconnect()

        asyncio.run(scenario())
