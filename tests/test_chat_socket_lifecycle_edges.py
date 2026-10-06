"""Lifecycle guidance and bounded context edges for the Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from tests.chat_socket_case import ChatDeliveryCase, resolved_future, uninstall_guidance_route

from chat import assistant_proposal, assistant_route, socket
from tests import chat_socket_fixtures


class ChatSocketLifecycleEdgeTests(ChatDeliveryCase):
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
                    return_value=uninstall_guidance_route("Which installed Assistant do you want to uninstall?"),
                ) as route,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("uninstall"),
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
            # The only event of the turn's own is the seal of its admitted send.
            self.assertEqual([call.args[1]["type"] for call in send.await_args_list], ["sent"])
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
                    return_value=resolved_future(assistant_route.Result("unresolved", error_status=422)),
                ) as route,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("desinstale o GitHub"),
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
                    return_value=uninstall_guidance_route(),
                ),
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("desinstale"),
                )
                delivery = connection.active.delivery
                await delivery
            self.assertTrue(connection.ignore_idle_stop_once)

            with mock.patch.object(socket, "_dispatch_chat", new=mock.AsyncMock()):
                await socket._dispatch(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("olá"),
                    mock.AsyncMock(),
                )
            self.assertFalse(connection.ignore_idle_stop_once)

            with mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send:
                await socket._dispatch_stop(websocket, connection, "team_1")
            self.assertEqual(send.await_args.args[-1]["status"], 409)

        asyncio.run(scenario())

    def test_guidance_for_a_noncanonical_message_remains_a_normal_question(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            guidance = assistant_route.Guidance(
                "assistant-uninstall-target-required",
                "Qual Assistant instalado você quer desinstalar?",
            )
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    return_value=resolved_future(assistant_route.Result("assistant-uninstall", guidance=guidance)),
                ),
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("desinstale\ue000"),
                )
                await connection.active.delivery

            self.assertEqual(websocket.send_json.await_args.args[-1]["reply"], guidance.reply)

        asyncio.run(scenario())

    def test_unavailable_conversation_projection_fails_before_routing(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.history_delivery,
                    "conversation",
                    new=mock.AsyncMock(side_effect=socket.history.HistoryUnavailableError("offline")),
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
                mock.patch.object(socket.lifecycle, "submit_route") as route,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("desinstale"),
                )

            self.assertEqual(send.await_args.args[-1]["status"], 503)
            route.assert_not_called()

        asyncio.run(scenario())

    def test_route_admission_saturation_preserves_the_lifecycle_reference(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            reference = assistant_proposal.AssistantReference("shimpz-cloudflare", "Shimpz Cloudflare")
            connection = socket._Connection(assistant_reference=reference)
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    side_effect=socket.ExecutorSaturatedError,
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame("cloudflare"),
                )

            self.assertIs(connection.assistant_reference, reference)
            self.assertEqual(send.await_args.args[-1]["status"], 429)

        asyncio.run(scenario())

    def test_chat_dispatch_carries_the_frame_locale_and_never_the_message_in_the_turn(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(chat_socket_fixtures.completed_turn("Done."))
            connection = socket._Connection()
            websocket = mock.AsyncMock()
            message = "x" * 2_001
            with mock.patch.object(socket, "submit_in_context", return_value=future):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    chat_socket_fixtures.chat_frame(message, locale="ja"),
                )

            turn = connection.active
            self.assertIsNotNone(turn)
            self.assertEqual(turn.locale, "ja")
            self.assertNotIn(message, repr(turn))
            await turn.delivery

        asyncio.run(scenario())

    def test_a_chat_frame_without_one_interface_locale_fails_closed(self) -> None:
        async def scenario() -> None:
            frames = (
                {"type": "chat", "message": "oi", "files": [], "assistant_ids": []},
                chat_socket_fixtures.chat_frame("oi", locale=None),
                chat_socket_fixtures.chat_frame("oi", locale="pt-BR"),
                {"type": "chat", "message": "oi", "files": [], "assistant_ids": [], "language_exemplar": "oi"},
                {
                    "type": "chat",
                    "message": "oi",
                    "files": [],
                    "assistant_ids": [],
                    "locale": "pt",
                    "timezone": None,
                    "request": None,
                    "language_exemplar": "oi",
                },
            )
            for frame in frames:
                with (
                    self.subTest(frame=frame),
                    mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
                    mock.patch.object(socket.lifecycle, "submit_route") as route,
                ):
                    connection = socket._Connection()
                    await socket._dispatch_chat(mock.AsyncMock(), connection, "team_1", frame)
                    self.assertEqual(send.await_args.args[-1]["status"], 400)
                    self.assertIsNone(connection.active)
                    route.assert_not_called()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
