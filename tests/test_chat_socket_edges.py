"""Cancellation, saturation, and delivery edges for the Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from tests.chat_socket_fixtures import human_challenge

from chat import human, local, socket


class ChatSocketEdgeTests(unittest.TestCase):
    def test_executor_and_static_origin_configuration_are_bounded(self) -> None:
        with self.assertRaises(ValueError):
            socket.BoundedThreadPoolExecutor(max_workers=2, max_outstanding=1, thread_name_prefix="bad")

        executor = socket.BoundedThreadPoolExecutor(max_workers=1, max_outstanding=1, thread_name_prefix="test")
        self.addCleanup(executor.shutdown, wait=True)
        permit = mock.Mock()
        permit.acquire.return_value = False
        executor._permits = permit
        with self.assertRaises(socket.ExecutorSaturatedError):
            executor.submit(lambda: None)
        permit.acquire.return_value = True
        with (
            mock.patch.object(
                concurrent.futures.ThreadPoolExecutor,
                "submit",
                side_effect=RuntimeError("failed"),
            ),
            self.assertRaisesRegex(RuntimeError, "failed"),
        ):
            executor.submit(lambda: None)
        permit.release.assert_called_once_with()

        with (
            mock.patch.dict(socket.os.environ, {"SHIMPZ_ADMIN_ALLOWED_ORIGINS": "bad"}),
            self.assertRaises(RuntimeError),
        ):
            socket._configured_origins()

    def test_projection_and_send_helpers_fail_closed(self) -> None:
        self.assertIsNone(socket._stop_accepted(object(), "team_1"))
        self.assertIsNone(socket._stop_accepted(local.PublicResponse(200, {"team_id": "team_2"}), "team_1"))

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.send_json.side_effect = RuntimeError("closed")
            self.assertFalse(await socket._send_event(websocket, {"type": "event"}))

            connection = socket._Connection()
            turn = socket._Turn(None, "chat")
            self.assertFalse(await socket._send_terminal_once(websocket, connection, turn, {"type": "done"}))
            self.assertTrue(connection.closed)
            self.assertFalse(await socket._send_terminal_once(websocket, connection, turn, {"type": "done"}))

            sync_connection = socket._Connection()
            self.assertFalse(await socket._send_sync_terminal_once(websocket, sync_connection, {"type": "error"}))
            self.assertTrue(sync_connection.closed)
            self.assertFalse(await socket._send_sync_event(websocket, sync_connection, {"type": "progress"}))

        asyncio.run(scenario())

    def test_turn_delivery_handles_missing_future_request_error_and_failed_challenge_send(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            turn = socket._Turn(None, "chat")
            self.assertEqual(await socket._await_turn_response(websocket, connection, turn), team.TeamResponse(502, {}))

            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_exception(team.TeamRequestError("invalid"))
            turn = socket._Turn(future, "chat", asyncio.Queue())
            connection.active = turn
            await socket._deliver_turn(websocket, connection, turn, "team_1")
            self.assertIsNone(connection.active)

            challenge = local.PublicResponse(
                428,
                {
                    "team_id": "team_1",
                    "status": "integrations-required",
                    "turn_id": "a" * 32,
                    "challenge_id": "a" * 32,
                    "expires_in": 300,
                    "requirements": [],
                },
            )
            future = concurrent.futures.Future()
            future.set_result(challenge)
            turn = socket._Turn(future, "chat", asyncio.Queue())
            connection = socket._Connection(active=turn)
            websocket.send_json.side_effect = RuntimeError("closed")
            await socket._deliver_turn(websocket, connection, turn, "team_1")
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_sync_delivery_covers_empty_invalid_and_missing_resume(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            empty = team.TeamResponse(200, {"team_id": "team_1", "status": "none"})

            connection = socket._Connection(pending_challenge_id="a" * 32)
            await socket._deliver_integration_sync(websocket, connection, "team_1", empty, None)
            self.assertIsNone(connection.pending_challenge_id)

            connection = socket._Connection()
            await socket._deliver_integration_sync(websocket, connection, "team_1", object(), None)
            self.assertTrue(connection.sync_terminal_sent)

            pending = local.PublicResponse(
                428,
                {
                    "team_id": "team_1",
                    "status": "integrations-required",
                    "turn_id": "a" * 32,
                    "challenge_id": "a" * 32,
                    "expires_in": 300,
                    "requirements": [],
                },
            )
            connection = socket._Connection()
            await socket._deliver_integration_sync(websocket, connection, "team_1", pending, None)
            self.assertTrue(connection.sync_terminal_sent)

            connection = socket._Connection()
            await socket._deliver_human_sync(websocket, connection, "team_1", empty)
            self.assertIsNone(connection.pending_challenge_id)

        asyncio.run(scenario())

    def test_sync_load_stop_and_dispatch_saturation_are_projected(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with mock.patch.object(socket, "_submit_in_context", side_effect=socket.ExecutorSaturatedError):
                self.assertIsNone(await socket._load_sync_snapshot(websocket, connection, "team_1"))
            self.assertTrue(connection.sync_terminal_sent)

            turn = socket._Turn(None, "pending-stop")
            connection = socket._Connection(active=turn)
            with mock.patch.object(socket, "_submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._run_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertTrue(turn.terminal_sent)
            self.assertIsNone(connection.active)

            connection = socket._Connection(sync_task=mock.Mock())
            await socket._dispatch_sync(websocket, connection, "team_1")

            connection = socket._Connection(active=socket._Turn(None, "chat"))
            await socket._dispatch_chat(
                websocket,
                connection,
                "team_1",
                {"type": "chat", "message": "hi", "files": [], "assistant_ids": []},
            )

            connection = socket._Connection(pending_challenge_id="a" * 32)
            await socket._dispatch_chat(
                websocket,
                connection,
                "team_1",
                {"type": "chat", "message": "hi", "files": [], "assistant_ids": []},
            )

            with mock.patch.object(socket, "_submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._dispatch_chat(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    {"type": "chat", "message": "hi", "files": [], "assistant_ids": []},
                )

        asyncio.run(scenario())

    def test_cancel_human_payload_stop_and_unsupported_dispatch_edges(self) -> None:
        async def authenticate(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("denied", attempts_remaining=2)

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket._Turn(future, "chat")
            connection = socket._Connection(active=turn)
            task = socket._request_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            await task

            deny, assurance, rejection, failure = await socket._human_payload(
                {"type": "human-response", "challenge_id": "a" * 32, "decision": "deny"},
                {"kind": "approval"},
                authenticate,
            )
            self.assertEqual(deny["decision"], "deny")
            self.assertIsNone(assurance)
            self.assertIsNone(rejection)
            self.assertIsNone(failure)

            request = {"kind": "auth:password"}
            payload, assurance, rejection, failure = await socket._human_payload(
                {
                    "type": "human-response",
                    "challenge_id": "a" * 32,
                    "decision": "submit",
                    "value": "password",
                },
                request,
                authenticate,
            )
            self.assertIsNone(payload)
            self.assertIsNone(assurance)
            self.assertEqual(rejection["type"], "human-response-rejected")
            self.assertEqual(rejection["attempts_remaining"], 2)
            self.assertIsNone(failure)

            await socket._dispatch_stop(websocket, socket._Connection(), "team_1")
            pending = socket._Connection(pending_challenge_id="a" * 32)
            await socket._dispatch_stop(websocket, pending, "team_1")
            self.assertIsNotNone(pending.active)

            await socket._dispatch(websocket, socket._Connection(), "team_1", {"type": "bad"}, authenticate)

        asyncio.run(scenario())

    def test_admission_maps_origin_authority_and_team_id_failures(self) -> None:
        async def session_ok(_cookies) -> bool:
            return True

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.headers = {"origin": "https://example.test"}
            websocket.scope = {"subprotocols": [socket.CHAT_SUBPROTOCOL]}
            websocket.cookies = {}
            self.assertIsNone(
                await socket._admit(
                    websocket,
                    "team_1",
                    session_ok,
                    lambda: (_ for _ in ()).throw(RuntimeError("offline")),
                )
            )
            self.assertIsNone(
                await socket._admit(
                    websocket,
                    "Bad",
                    session_ok,
                    lambda: frozenset({"https://example.test"}),
                )
            )

        asyncio.run(scenario())

    def test_remaining_delivery_and_sync_failure_edges_are_terminal(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.send_json.side_effect = RuntimeError("closed")
            connection = socket._Connection()
            self.assertFalse(await socket._send_sync_event(websocket, connection, {"type": "sync-empty"}))
            self.assertTrue(connection.closed)

            pending_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            closed = socket._Connection(closed=True)
            turn = socket._Turn(pending_future, "chat")
            with mock.patch.object(socket, "_request_stop", return_value=None):
                await socket._stop_closed_turn(websocket, closed, turn, "team_1")

            websocket = mock.AsyncMock()
            detached = socket._Connection()
            await socket._deliver_turn(websocket, detached, socket._Turn(None, "chat"), "team_1")

            failure = local.PublicResponse(503, {"team_id": "team_1"})
            self.assertEqual(socket._pending_error(failure, "team_1", "human")["status"], 503)

            pending = local.PublicResponse(
                428,
                {
                    "team_id": "team_1",
                    "status": "integrations-required",
                    "turn_id": "a" * 32,
                    "challenge_id": "a" * 32,
                    "expires_in": 300,
                    "requirements": [],
                },
            )
            invalid_resumed = team.TeamResponse(428, {"status": "integrations-required"})
            await socket._deliver_integration_sync(
                websocket,
                socket._Connection(),
                "team_1",
                pending,
                invalid_resumed,
            )
            await socket._deliver_human_sync(websocket, socket._Connection(), "team_1", failure)

        asyncio.run(scenario())

    def test_sync_loader_and_delivery_cover_empty_closed_and_send_failure_results(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            with mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=None)):
                self.assertIsNone(await socket._load_sync_snapshot(websocket, socket._Connection(), "team_1"))

            with mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(return_value=None)):
                await socket._deliver_sync(websocket, socket._Connection(), "team_1")

            snapshot = socket._SyncSnapshot("human", object())
            with mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(return_value=snapshot)):
                await socket._deliver_sync(websocket, socket._Connection(closed=True), "team_1")

            connection = socket._Connection()
            with (
                mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(side_effect=RuntimeError)),
                mock.patch.object(socket, "_send_sync_terminal_once", new=mock.AsyncMock(return_value=False)),
            ):
                await socket._deliver_sync(websocket, connection, "team_1")
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_stop_races_cover_noop_cancel_and_finished_pending_turn(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            response_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            response_future.set_result(local.PublicResponse(200, {"team_id": "team_1", "stopped": False}))
            turn = socket._Turn(None, "pending-stop")
            connection = socket._Connection(active=turn)
            with mock.patch.object(socket, "_submit_in_context", return_value=response_future):
                await socket._run_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertTrue(turn.terminal_sent)

            detached_turn = socket._Turn(None, "chat")
            await socket._finish_cancelled_turn(websocket, socket._Connection(), detached_turn)

            cancellable: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket._Turn(cancellable, "chat")
            self.assertIsNone(
                socket._request_stop(websocket, socket._Connection(active=turn), turn, "team_1", emit=False)
            )

        asyncio.run(scenario())

    def test_human_continuation_covers_empty_challenge_busy_and_saturation_results(self) -> None:
        async def authenticate(_kind: str, _secret: str) -> str:
            return "verified"

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            progress: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            with mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=None)):
                await socket._deliver_human_response(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    future,
                    progress,
                    None,
                )
                await socket._deliver_human_response(
                    websocket,
                    socket._Connection(closed=True),
                    "team_1",
                    future,
                    progress,
                    None,
                )

            challenge = human_challenge("approval")
            connection = socket._Connection()
            with mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=challenge)):
                await socket._deliver_human_response(websocket, connection, "team_1", future, progress, None)
            self.assertEqual(connection.pending_challenge_type, "human")

            frame = {
                "type": "human-response",
                "challenge_id": "b" * 32,
                "decision": "submit",
                "value": True,
            }
            busy = socket._Connection(active=socket._Turn(None, "chat"))
            await socket._dispatch_human_response(websocket, busy, "team_1", frame, authenticate)

            request = challenge.websocket_event("team_1")["request"]
            available = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=request,
            )
            with mock.patch.object(socket, "_submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._dispatch_human_response(websocket, available, "team_1", frame, authenticate)

            blocked = socket._Connection(sync_task=mock.Mock(), sync_terminal_sent=True)
            await socket._dispatch_stop(websocket, blocked, "team_1")

        asyncio.run(scenario())

    def test_human_authentication_failure_edges_remain_fail_closed(self) -> None:
        async def unavailable(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("unavailable")

        async def denied(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("denied", attempts_remaining=2)

        async def scenario() -> None:
            auth_request = human_challenge("auth:password").websocket_event("team_1")["request"]
            frame = {
                "type": "human-response",
                "challenge_id": "b" * 32,
                "decision": "submit",
                "value": "password",
            }
            payload, assurance, rejection, failure = await socket._human_payload(
                dict(frame),
                auth_request,
                unavailable,
            )
            self.assertEqual(payload, {"challenge_id": "b" * 32, "decision": "deny"})
            self.assertIsNone(assurance)
            self.assertIsNone(rejection)
            self.assertEqual(failure, (503, "authentication is unavailable"))

            denied_response = local.PublicResponse(409, {"code": "human-request-denied"})
            self.assertTrue(socket._authenticated_denial(denied_response))
            self.assertFalse(socket._authenticated_denial(object()))
            self.assertFalse(socket._authenticated_denial(local.PublicResponse(200, denied_response.body)))
            self.assertFalse(socket._authenticated_denial(local.PublicResponse(409, {})))

            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            progress: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            send_terminal = mock.AsyncMock(return_value=True)
            with (
                mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=denied_response)),
                mock.patch.object(socket, "_send_sync_terminal_once", send_terminal),
            ):
                await socket._deliver_human_response(
                    mock.AsyncMock(),
                    socket._Connection(),
                    "team_1",
                    future,
                    progress,
                    failure,
                )
            self.assertEqual(send_terminal.await_args.args[2]["status"], 503)

            completed = local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Completed."},
            )
            send_terminal.reset_mock()
            with (
                mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=completed)),
                mock.patch.object(socket, "_send_sync_terminal_once", send_terminal),
            ):
                await socket._deliver_human_response(
                    mock.AsyncMock(),
                    socket._Connection(),
                    "team_1",
                    future,
                    progress,
                    failure,
                )
            self.assertEqual(send_terminal.await_args.args[2]["type"], "done")

            pending = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=auth_request,
            )
            with mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=False)):
                await socket._dispatch_human_response(mock.AsyncMock(), pending, "team_1", dict(frame), denied)
            self.assertTrue(pending.closed)

            malformed = socket._Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=auth_request,
            )
            websocket = mock.AsyncMock()
            with mock.patch.object(
                socket,
                "_human_payload",
                new=mock.AsyncMock(return_value=(None, None, None, None)),
            ):
                await socket._dispatch_human_response(websocket, malformed, "team_1", dict(frame), unavailable)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)

        asyncio.run(scenario())

    def test_server_cleanup_accepts_an_already_finished_turn_without_tasks(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.cookies = {}
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(object())
            connection = socket._Connection(active=socket._Turn(future, "chat"))
            with (
                mock.patch.object(socket, "_admit", new=mock.AsyncMock(return_value="team_1")),
                mock.patch.object(socket, "_Connection", return_value=connection),
                mock.patch.object(
                    socket,
                    "receive_bounded_json",
                    new=mock.AsyncMock(side_effect=socket.WebSocketDisconnect),
                ),
            ):
                await socket.serve(
                    websocket,
                    "team_1",
                    session_ok=mock.AsyncMock(return_value=True),
                    request_scope=lambda _cookies: contextlib.nullcontext(),
                    allowed_origins=lambda: frozenset(),
                    authenticate=mock.AsyncMock(return_value=human.AuthenticationResult("verified")),
                )

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
