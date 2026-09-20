"""Fail-closed history edges at chat lifecycle boundaries."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat.delivery import plan as plan_delivery

from chat import assistant_route, local, socket, task_resume


def _resume_operations() -> task_resume.Operations:
    return task_resume.Operations(
        send_event=socket._send_event,
        plan=plan_delivery.Operations(
            send_event=socket._send_event,
            finish_turn=socket._finish_active_turn,
            continue_turn=socket._continue_team_turn,
            error_terminal=socket._error_terminal,
        ),
        error_terminal=socket._error_terminal,
    )


def _future(value: object) -> concurrent.futures.Future[object]:
    future: concurrent.futures.Future[object] = concurrent.futures.Future()
    future.set_result(value)
    return future


class ChatHistoryFailureEdgeTests(unittest.TestCase):
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

    def test_uninstall_guidance_and_pending_stop_history_failures_are_explicit(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.history_delivery,
                    "guidance",
                    new=mock.AsyncMock(side_effect=socket.history.HistoryUnavailableError("offline")),
                ),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    return_value=_future(
                        assistant_route.Result(
                            "assistant-uninstall",
                            guidance="assistant-uninstall-target-required",
                        )
                    ),
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                await socket._dispatch_chat(
                    websocket,
                    connection,
                    "team_1",
                    {"type": "chat", "message": "desinstale", "files": [], "assistant_ids": []},
                )
                delivery = connection.active.delivery
                await delivery
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)
            send.assert_not_awaited()

            pending = socket._Connection(pending_challenge_id="a" * 32)
            with (
                mock.patch.object(
                    socket.history_delivery,
                    "resume",
                    new=mock.AsyncMock(side_effect=socket.history.HistoryUnavailableError("offline")),
                ),
                mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=True)) as send,
            ):
                await socket._dispatch_stop(websocket, pending, "team_1")
            self.assertEqual(send.await_args.args[1]["status"], 503)
            self.assertIsNone(pending.active)

        asyncio.run(scenario())

    def test_assistant_route_without_future_can_still_be_stopped(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            turn = socket._Turn(None, "assistant-route", lifecycle_stop=threading.Event())
            connection = socket._Connection(active=turn)
            task = socket._request_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            await task
            self.assertIsNone(connection.active)

        asyncio.run(scenario())

    def test_non_denial_authentication_response_preserves_the_challenge(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            connection = socket._Connection(
                pending_challenge_id="a" * 32,
                pending_challenge_type="human",
            )
            response = local.PublicResponse(503, {"team_id": "team_1", "code": "offline"})
            with mock.patch.object(
                socket,
                "_await_progress_result",
                new=mock.AsyncMock(return_value=response),
            ):
                await socket._deliver_human_response(
                    websocket,
                    connection,
                    "team_1",
                    future,
                    asyncio.Queue(),
                    (401, "authentication failed"),
                )
            self.assertEqual(connection.pending_challenge_id, "a" * 32)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)

        asyncio.run(scenario())

    def test_task_resume_history_failure_stops_before_planning(self) -> None:
        async def scenario() -> None:
            frame = {
                "type": "resume-task",
                "message": "Você mesmo consegue habilitar?",
                "objective": "Lista minhas zonas DNS no Cloudflare",
                "files": [],
                "assistant_ids": [],
                "objective_assistant_ids": [],
            }
            websocket = mock.AsyncMock()
            with (
                mock.patch.object(
                    task_resume.history_delivery,
                    "admit",
                    new=mock.AsyncMock(side_effect=socket.history.HistoryUnavailableError("offline")),
                ),
                mock.patch.object(task_resume.lifecycle, "submit_resume") as prepare,
            ):
                await task_resume.dispatch(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    frame,
                    _resume_operations(),
                )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)
            prepare.assert_not_called()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
