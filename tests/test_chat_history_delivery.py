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

from chat.delivery import sync as sync_delivery

from chat import socket
from tests import chat_socket_fixtures


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

    def test_resumed_non_reply_terminal_releases_the_exact_challenge(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Approve the Action"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(pending_history_id=turn_id)
            websocket = mock.AsyncMock()

            await sync_delivery.human(
                websocket,
                connection,
                "team_1",
                chat_socket_fixtures.human_challenge("approval"),
                socket._SYNC_OPERATIONS,
            )
            self.assertEqual(connection.pending_history_id, turn_id)
            self.assertTrue(
                await socket._send_sync_terminal_once(
                    websocket,
                    connection,
                    {"type": "error", "status": 409, "detail": "Action denied"},
                    finish_history=True,
                )
            )
            self.assertIsNone(socket.history.resumable_turn("team_1"))
            self.assertIsNone(connection.pending_history_id)

        asyncio.run(scenario())

    def test_empty_sync_releases_an_abandoned_challenge(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Expired approval"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_history_id=turn_id,
            )
            websocket = mock.AsyncMock()

            await sync_delivery.empty(websocket, connection, socket._SYNC_OPERATIONS)

            self.assertIsNone(socket.history.resumable_turn("team_1"))
            self.assertIsNone(connection.pending_challenge_id)
            websocket.send_json.assert_awaited_once_with({"type": "sync-empty"})

        asyncio.run(scenario())

    def test_empty_sync_never_releases_a_newer_binding(self) -> None:
        async def scenario() -> None:
            first = socket.history.new_turn_id()
            second = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", first, "Expired approval"))
            self.assertTrue(socket.history.append_user("team_1", second, "New approval"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", first))
            connection = socket._Connection(pending_history_id=first)

            socket.history.finish_resumable_turn(first)
            self.assertTrue(socket.history.bind_resumable_turn("team_1", second))
            await sync_delivery.empty(mock.AsyncMock(), connection, socket._SYNC_OPERATIONS)

            self.assertEqual(socket.history.resumable_turn("team_1"), second)

        asyncio.run(scenario())

    def test_uncertain_integration_resume_preserves_the_binding(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Connect Cloudflare"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(pending_history_id=turn_id)
            pending = chat_socket_fixtures.integration_challenge().websocket_event("team_1")
            websocket = mock.AsyncMock()

            await sync_delivery.integration_terminal(
                websocket,
                connection,
                "team_1",
                pending,
                socket.local.PublicResponse(503, {"code": "offline"}),
                socket._SYNC_OPERATIONS,
            )

            self.assertEqual(socket.history.resumable_turn("team_1"), turn_id)
            self.assertEqual(connection.pending_challenge_id, pending["challenge_id"])
            self.assertEqual(websocket.send_json.await_args.args[0]["type"], "error")

        asyncio.run(scenario())

    def test_uncertain_human_resume_preserves_the_binding(self) -> None:
        async def scenario() -> None:
            turn_id = socket.history.new_turn_id()
            self.assertTrue(socket.history.append_user("team_1", turn_id, "Approve the Action"))
            self.assertTrue(socket.history.bind_resumable_turn("team_1", turn_id))
            connection = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_history_id=turn_id,
            )
            future = asyncio.get_running_loop().create_future()
            websocket = mock.AsyncMock()
            with mock.patch.object(
                socket,
                "_await_progress_result",
                new=mock.AsyncMock(return_value=socket.local.PublicResponse(503, {"code": "offline"})),
            ):
                await socket._deliver_human_response(
                    websocket,
                    connection,
                    "team_1",
                    future,
                    asyncio.Queue(),
                    None,
                )

            self.assertEqual(socket.history.resumable_turn("team_1"), turn_id)
            self.assertEqual(connection.pending_challenge_id, "b" * 32)
            self.assertEqual(websocket.send_json.await_args.args[0]["type"], "error")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
