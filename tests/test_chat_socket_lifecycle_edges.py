"""Lifecycle guidance and bounded context edges for the Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat import assistant_route, local, socket


def _future(value: object) -> concurrent.futures.Future[object]:
    future: concurrent.futures.Future[object] = concurrent.futures.Future()
    future.set_result(value)
    return future


class ChatSocketLifecycleEdgeTests(unittest.TestCase):
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

    def test_targetless_uninstall_guidance_survives_a_retired_ambiguous_proposal(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection(lifecycle_proposal=mock.sentinel.proposal)

            async def retire_proposal(*_args) -> bool:
                connection.lifecycle_proposal = None
                return False

            with (
                mock.patch.object(socket.lifecycle, "resolve", side_effect=retire_proposal),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    return_value=_future(
                        assistant_route.Result(
                            "assistant-uninstall",
                            guidance=assistant_route.Guidance(
                                "assistant-uninstall-target-required",
                                "Which installed Assistant do you want to uninstall?",
                            ),
                        )
                    ),
                ) as route,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    {"type": "chat", "message": "uninstall", "files": [], "assistant_ids": []},
                )
                delivery = connection.active.delivery
                await delivery

            websocket.send_json.assert_awaited_once_with(
                {
                    "type": "assistant-guidance",
                    "team_id": "team_1",
                    "code": "assistant-uninstall-target-required",
                    "reply": "Which installed Assistant do you want to uninstall?",
                },
            )
            send.assert_not_awaited()
            route.assert_called_once()

        asyncio.run(scenario())

    def test_targeted_uninstall_after_retired_proposal_never_enters_install_planning(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection(lifecycle_proposal=mock.sentinel.proposal)

            async def retire_proposal(*_args) -> bool:
                connection.lifecycle_proposal = None
                return False

            with (
                mock.patch.object(socket.lifecycle, "resolve", side_effect=retire_proposal),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    return_value=_future(assistant_route.Result("unresolved", error_status=422)),
                ) as route,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    {
                        "type": "chat",
                        "message": "desinstale o GitHub",
                        "files": [],
                        "assistant_ids": [],
                    },
                )
                delivery = connection.active.delivery
                await delivery

            route.assert_called_once()

        asyncio.run(scenario())

    def test_non_stop_frame_clears_target_guidance_stop_suppression(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    return_value=_future(
                        assistant_route.Result(
                            "assistant-uninstall",
                            guidance=assistant_route.Guidance(
                                "assistant-uninstall-target-required",
                                "Qual Assistant instalado você quer desinstalar?",
                            ),
                        )
                    ),
                ),
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    {"type": "chat", "message": "desinstale", "files": [], "assistant_ids": []},
                )
                delivery = connection.active.delivery
                await delivery
            self.assertTrue(connection.ignore_idle_stop_once)

            with mock.patch.object(socket, "_dispatch_chat", new=mock.AsyncMock()):
                await socket._dispatch(
                    websocket,
                    connection,
                    "team_1",
                    {"type": "chat", "message": "olá", "files": [], "assistant_ids": []},
                    mock.AsyncMock(),
                )
            self.assertFalse(connection.ignore_idle_stop_once)

            with mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send:
                await socket._dispatch_stop(websocket, connection, "team_1")
            self.assertEqual(send.await_args.args[-1]["status"], 409)

        asyncio.run(scenario())

    def test_turn_keeps_only_a_repr_hidden_bounded_language_exemplar(self) -> None:
        turn = socket._Turn(None, "chat", language_exemplar="Liste minhas zonas DNS")

        self.assertEqual(turn.language_exemplar, "Liste minhas zonas DNS")
        self.assertNotIn("Liste minhas zonas DNS", repr(turn))

    def test_chat_dispatch_omits_an_overlong_language_exemplar(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(
                local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "Done."},
                )
            )
            connection = socket._Connection()
            websocket = mock.AsyncMock()
            message = "x" * 2_001
            with mock.patch.object(socket, "submit_in_context", return_value=future):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    {"type": "chat", "message": message, "files": [], "assistant_ids": []},
                )

            turn = connection.active
            self.assertIsNotNone(turn)
            self.assertIsNone(turn.language_exemplar)
            self.assertNotIn(message, repr(turn))
            await turn.delivery

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
