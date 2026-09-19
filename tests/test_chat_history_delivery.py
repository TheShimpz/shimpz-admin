"""Persistence-before-projection edges for Local Admin chat history."""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import socket


class ChatHistoryDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        previous = socket.history.STORE_PATH
        socket.history.STORE_PATH = Path(cls.temporary.name) / "chat-history.sqlite3"
        cls.addClassCleanup(setattr, socket.history, "STORE_PATH", previous)

    def setUp(self) -> None:
        socket.history.STORE_PATH.unlink(missing_ok=True)
        socket.history_delivery.configure("local")

    def test_admission_commits_user_history_before_work_can_start(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            frame = {"type": "chat", "message": "Hello", "files": [], "assistant_ids": []}
            with (
                mock.patch.object(socket.history, "new_turn_id", return_value="a" * 32),
                mock.patch.object(socket.history, "append_user", return_value=True) as append,
            ):
                payload = await socket._admit_chat_payload(websocket, connection, "team_1", frame)
            self.assertEqual(payload, {"message": "Hello", "files": [], "assistant_ids": []})
            self.assertEqual(connection.admitted_history_id, "a" * 32)
            append.assert_called_once_with("team_1", "a" * 32, "Hello")

            connection = socket._Connection()
            with (
                mock.patch.object(socket.history, "new_turn_id", return_value="b" * 32),
                mock.patch.object(
                    socket.history,
                    "append_user",
                    side_effect=socket.history.HistoryUnavailableError("full"),
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                self.assertIsNone(await socket._admit_chat_payload(websocket, connection, "team_1", frame))
            self.assertIsNone(connection.admitted_history_id)
            self.assertEqual(send.await_args.args[1]["status"], 503)

        asyncio.run(scenario())

    def test_terminal_reply_is_committed_before_socket_projection(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            turn = socket._Turn(None, "chat", history_id="a" * 32)
            event = {"type": "done", "team_id": "team_1", "team_name": "Team 1", "reply": "Done"}
            with mock.patch.object(socket.history, "append_reply", return_value=True) as append:
                self.assertTrue(await socket._send_terminal_once(websocket, connection, turn, event))
            append.assert_called_once_with("team_1", "a" * 32, event)
            websocket.send_json.assert_awaited_once_with(event)

        asyncio.run(scenario())

    def test_uncommitted_terminal_reply_fails_visibly(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            turn = socket._Turn(None, "chat", history_id="a" * 32)
            event = {"type": "done", "team_id": "team_1", "team_name": "Team 1", "reply": "Done"}
            with mock.patch.object(socket.history, "append_reply", return_value=False):
                self.assertTrue(await socket._send_terminal_once(websocket, connection, turn, event))
            projected = websocket.send_json.await_args.args[0]
            self.assertEqual(projected["type"], "error")
            self.assertEqual(projected["status"], 503)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
