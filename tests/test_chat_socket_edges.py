"""Cancellation, saturation, and delivery edges for the Admin chat WebSocket."""

import asyncio
import concurrent.futures
import contextlib
import importlib
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat.delivery import sync as sync_delivery
from team import transport
from tests.chat_socket_case import ChatDeliveryCase, resume_operations
from tests.chat_socket_fixtures import human_challenge, human_response

from chat import human, local, socket, task_resume
from tests import chat_socket_fixtures


def _empty_integration_challenge() -> local.PublicResponse:
    """A pending integration challenge that names no requirement."""
    body = {
        "team_id": "team_1",
        "status": "integrations-required",
        "turn_id": "a" * 32,
        "challenge_id": "a" * 32,
        "expires_in": 300,
        "requirements": [],
    }
    return local.PublicResponse(428, body)


class ChatSocketEdgeTests(ChatDeliveryCase):
    def test_continuation_stop_saturation_and_detached_finish_are_terminal(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            turn = socket.Turn(None, "capability-plan", stop_requested=True)
            connection = socket.Connection(active=turn)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()) as send:
                await socket._continue_team_turn(websocket, connection, turn, "team_1", {})
            send.assert_awaited_once()
            self.assertIsNone(connection.active)

            turn = socket.Turn(None, "capability-plan")
            connection = socket.Connection(active=turn)
            with (
                mock.patch.object(socket, "_submit_team_turn", side_effect=socket.ExecutorSaturatedError),
                mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()) as send,
            ):
                await socket._continue_team_turn(websocket, connection, turn, "team_1", {})
            self.assertEqual(send.await_args.args[-1]["status"], 429)
            self.assertIsNone(connection.active)

            active = socket.Turn(None, "chat")
            detached = socket.Turn(None, "capability-plan", stop_requested=True)
            connection = socket.Connection(active=active)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()):
                await socket._continue_team_turn(websocket, connection, detached, "team_1", {})
            self.assertIs(connection.active, active)

            detached = socket.Turn(None, "capability-plan")
            with (
                mock.patch.object(socket, "_submit_team_turn", side_effect=socket.ExecutorSaturatedError),
                mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()),
            ):
                await socket._continue_team_turn(websocket, connection, detached, "team_1", {})
            self.assertIs(connection.active, active)

            detached = socket.Turn(None, "chat")
            connection = socket.Connection(active=active)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()):
                await socket._finish_active_turn(websocket, connection, detached, {"type": "done"})
            self.assertIs(connection.active, active)

        asyncio.run(scenario())

    def test_lifecycle_stop_cancels_nonplan_work_and_emits_once(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket.Turn(future, "chat", lifecycle_stop=threading.Event())
            connection = socket.Connection(active=turn)
            task = socket._request_stop(mock.AsyncMock(), connection, turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            self.assertTrue(future.cancelled())
            self.assertTrue(turn.lifecycle_stop.is_set())
            await task

            turn = socket.Turn(None, "chat", lifecycle_stop=threading.Event())
            task = socket._request_stop(mock.AsyncMock(), socket.Connection(active=turn), turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            await task

            future = concurrent.futures.Future()
            turn = socket.Turn(future, "chat", lifecycle_stop=threading.Event())
            self.assertIsNone(
                socket._request_stop(
                    mock.AsyncMock(),
                    socket.Connection(active=turn),
                    turn,
                    "team_1",
                    emit=False,
                )
            )
            self.assertTrue(future.cancelled())

        asyncio.run(scenario())

    def test_route_saturation_is_bounded(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            frame = chat_socket_fixtures.chat_frame("hello")
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    side_effect=socket.ExecutorSaturatedError,
                ),
            ):
                await socket._dispatch_chat(websocket, socket.Connection(), "team_1", frame)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 429)

        asyncio.run(scenario())

    def test_a_chat_frame_is_exact(self) -> None:
        frame = chat_socket_fixtures.chat_frame("Hello")

        async def scenario() -> None:
            for candidate in (
                {**frame, "request": None},
                {key: value for key, value in frame.items() if key != "timezone"},
                {**frame, "locale": "pt-BR"},
            ):
                websocket = mock.AsyncMock()
                with mock.patch.object(socket.history, "append_user") as append:
                    self.assertIsNone(
                        await socket._admit_chat_payload(websocket, socket.Connection(), "team_1", candidate)
                    )
                append.assert_not_called()
                self.assertEqual(websocket.send_json.await_args.args[0]["status"], 400)

        asyncio.run(scenario())

    def test_resume_task_admission_is_exact_and_authoritatively_revalidated(self) -> None:
        valid = chat_socket_fixtures.resume_frame()

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            admitted = await task_resume.admit(websocket, socket.Connection(), valid, resume_operations())
            self.assertEqual(
                admitted[:2],
                (
                    {"message": valid["message"], "files": [], "assistant_ids": [], "locale": "en", "timezone": None},
                    {"message": valid["objective"], "files": [], "assistant_ids": [], "locale": "en", "timezone": None},
                ),
            )
            self.assertRegex(admitted[2]["nonce"], r"\A[0-9a-f]{32}\Z")
            websocket.send_json.assert_not_called()

            invalid = (
                {**valid, "extra": True},
                {**valid, "files": ["a" * 32]},
                {**valid, "assistant_ids": ["whatsapp"]},
                {**valid, "message": "como faço para habilitar o modo escuro"},
                {**valid, "objective": "pode habilitar"},
                {key: value for key, value in valid.items() if key != "locale"},
                {**valid, "locale": None},
                {**valid, "locale": "pt-BR"},
                {**valid, "request": None},
            )
            for frame in invalid:
                websocket.reset_mock()
                self.assertIsNone(
                    await task_resume.admit(
                        websocket,
                        socket.Connection(),
                        frame,
                        resume_operations(),
                    )
                )
                self.assertEqual(websocket.send_json.await_args.args[0]["status"], 400)

            websocket.reset_mock()
            self.assertIsNone(
                await task_resume.admit(
                    websocket,
                    socket.Connection(active=socket.Turn(None, "chat")),
                    valid,
                    resume_operations(),
                )
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

            websocket.reset_mock()
            self.assertIsNone(
                await task_resume.admit(
                    websocket,
                    socket.Connection(pending_challenge_id="c" * 32),
                    valid,
                    resume_operations(),
                )
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

            websocket.reset_mock()
            with mock.patch.object(socket.lifecycle, "submit_resume") as prepare:
                await task_resume.dispatch(
                    websocket,
                    socket.Connection(),
                    "team_1",
                    {**valid, "extra": True},
                    resume_operations(),
                )
            prepare.assert_not_called()
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 400)

        asyncio.run(scenario())

    def test_resume_task_plans_the_prior_objective_without_semantic_fallback(self) -> None:
        frame = chat_socket_fixtures.resume_frame()

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            with (
                mock.patch.object(
                    socket.lifecycle,
                    "submit_resume",
                    side_effect=socket.ExecutorSaturatedError,
                ) as prepare,
            ):
                await task_resume.dispatch(
                    websocket,
                    socket.Connection(),
                    "team_1",
                    frame,
                    resume_operations(),
                )
            objective = {
                "message": frame["objective"],
                "files": [],
                "assistant_ids": [],
                "locale": "en",
                "timezone": None,
            }
            prepare.assert_called_once_with("team_1", objective)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 429)

            preparation: concurrent.futures.Future[object] = concurrent.futures.Future()
            deliver = mock.AsyncMock()
            connection = socket.Connection()
            with (
                mock.patch.object(socket.lifecycle, "submit_resume", return_value=preparation),
                mock.patch.object(socket.route_delivery, "deliver", new=deliver),
            ):
                await task_resume.dispatch(
                    websocket,
                    connection,
                    "team_1",
                    dict(frame),
                    resume_operations(),
                )
                await connection.active.delivery
            deliver.assert_awaited_once_with(
                websocket,
                connection,
                connection.active,
                "team_1",
                objective,
                mock.ANY,
                fallback_payload={
                    "message": frame["message"],
                    "files": [],
                    "assistant_ids": [],
                    "locale": "en",
                    "timezone": None,
                },
            )

        asyncio.run(scenario())

    def test_executor_and_static_origin_configuration_are_bounded(self) -> None:
        with self.assertRaises(ValueError):
            socket.lanes.BoundedThreadPoolExecutor(max_workers=2, max_outstanding=1, thread_name_prefix="bad")

        executor = socket.lanes.BoundedThreadPoolExecutor(max_workers=1, max_outstanding=1, thread_name_prefix="test")
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

        browser = importlib.import_module("browser")
        with (
            mock.patch.dict(browser.os.environ, {"SHIMPZ_ADMIN_ALLOWED_ORIGINS": "bad"}),
            self.assertRaises(RuntimeError),
        ):
            browser.configured_origins()

    def test_projection_and_send_helpers_fail_closed(self) -> None:
        self.assertIsNone(socket.stop_accepted(object(), "team_1"))
        self.assertIsNone(socket.stop_accepted(local.PublicResponse(200, {"team_id": "team_2"}), "team_1"))

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.send_json.side_effect = RuntimeError("closed")
            self.assertFalse(await socket._send_event(websocket, {"type": "event"}))

            connection = socket.Connection()
            turn = socket.Turn(None, "chat")
            self.assertFalse(await socket._send_terminal_once(websocket, connection, turn, {"type": "done"}))
            self.assertTrue(connection.closed)
            self.assertFalse(await socket._send_terminal_once(websocket, connection, turn, {"type": "done"}))

            sync_connection = socket.Connection()
            self.assertFalse(await socket._send_sync_terminal_once(websocket, sync_connection, {"type": "error"}))
            self.assertTrue(sync_connection.closed)
            self.assertFalse(await socket._send_sync_event(websocket, sync_connection, {"type": "progress"}))

        asyncio.run(scenario())

    def test_turn_delivery_handles_missing_future_request_error_and_failed_challenge_send(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket.Connection()
            turn = socket.Turn(None, "chat")
            self.assertEqual(
                await socket._await_turn_response(websocket, connection, turn), transport.TeamResponse(502, {})
            )

            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_exception(transport.TeamRequestError("invalid"))
            turn = socket.Turn(future, "chat", asyncio.Queue())
            connection.active = turn
            await socket._deliver_turn(websocket, connection, turn, "team_1")
            self.assertIsNone(connection.active)

            challenge = _empty_integration_challenge()
            future = concurrent.futures.Future()
            future.set_result(challenge)
            turn = socket.Turn(future, "chat", asyncio.Queue())
            connection = socket.Connection(active=turn)
            websocket.send_json.side_effect = RuntimeError("closed")
            await socket._deliver_turn(websocket, connection, turn, "team_1")
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_sync_delivery_covers_empty_invalid_and_missing_resume(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            empty = transport.TeamResponse(200, {"team_id": "team_1", "status": "none"})

            connection = socket.Connection(pending_challenge_id="a" * 32)
            await sync_delivery.integration(websocket, connection, "team_1", empty, None, socket._SYNC_OPERATIONS)
            self.assertIsNone(connection.pending_challenge_id)

            connection = socket.Connection()
            await sync_delivery.integration(websocket, connection, "team_1", object(), None, socket._SYNC_OPERATIONS)
            self.assertTrue(connection.sync_terminal_sent)

            pending = _empty_integration_challenge()
            connection = socket.Connection()
            await sync_delivery.integration(websocket, connection, "team_1", pending, None, socket._SYNC_OPERATIONS)
            self.assertTrue(connection.sync_terminal_sent)

            connection = socket.Connection()
            await sync_delivery.human(websocket, connection, "team_1", empty, socket._SYNC_OPERATIONS)
            self.assertIsNone(connection.pending_challenge_id)

        asyncio.run(scenario())

    def test_sync_load_stop_and_dispatch_saturation_are_projected(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket.Connection()
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
                self.assertIsNone(await socket._load_sync_snapshot(websocket, connection, "team_1", "en"))
            self.assertTrue(connection.sync_terminal_sent)

            turn = socket.Turn(None, "pending-stop")
            connection = socket.Connection(active=turn)
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._run_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertTrue(turn.terminal_sent)
            self.assertIsNone(connection.active)

            connection = socket.Connection(sync_task=mock.Mock())
            await socket._dispatch_sync(websocket, connection, "team_1", "en")

            connection = socket.Connection(active=socket.Turn(None, "chat"))
            await socket._dispatch_chat(
                websocket,
                connection,
                "team_1",
                chat_socket_fixtures.chat_frame("hi"),
            )

            connection = socket.Connection(pending_challenge_id="a" * 32)
            await socket._dispatch_chat(
                websocket,
                connection,
                "team_1",
                chat_socket_fixtures.chat_frame("hi"),
            )

            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._dispatch_chat(
                    websocket,
                    socket.Connection(),
                    "team_1",
                    chat_socket_fixtures.chat_frame("hi"),
                )

        asyncio.run(scenario())

    def test_cancel_human_payload_stop_and_unsupported_dispatch_edges(self) -> None:
        async def authenticate(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("denied", attempts_remaining=2)

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket.Turn(future, "chat")
            connection = socket.Connection(active=turn)
            task = socket._request_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            await task

            deny, assurance, rejection, failure = await human.response_payload(
                {"type": "human-response", "challenge_id": "a" * 32, "decision": "deny"},
                {"kind": "approval"},
                authenticate,
            )
            self.assertEqual(deny["decision"], "deny")
            self.assertIsNone(assurance)
            self.assertIsNone(rejection)
            self.assertIsNone(failure)

            request = {"kind": "auth:password"}
            payload, assurance, rejection, failure = await human.response_payload(
                human_response("password", challenge_id="a" * 32),
                request,
                authenticate,
            )
            self.assertIsNone(payload)
            self.assertIsNone(assurance)
            self.assertEqual(rejection["type"], "human-response-rejected")
            self.assertEqual(rejection["attempts_remaining"], 2)
            self.assertIsNone(failure)

            await socket._dispatch_stop(websocket, socket.Connection(), "team_1")
            pending = socket.Connection(
                pending_challenge_id="a" * 32,
                pending_history_id="a" * 32,
            )
            await socket._dispatch_stop(websocket, pending, "team_1")
            self.assertIsNotNone(pending.active)

            await socket._dispatch(websocket, socket.Connection(), "team_1", {"type": "bad"}, authenticate)
            # A sync frame names exactly one interface language for a restored request (ADR-0091).
            for frame in ({"type": "sync"}, {"type": "sync", "locale": "xx"}, {"type": "sync", "locale": None}):
                await socket._dispatch(websocket, socket.Connection(), "team_1", frame, authenticate)
                self.assertEqual(
                    websocket.send_json.await_args.args[0],
                    {"type": "error", "status": 400, "detail": "unsupported chat frame"},
                )
            await socket._dispatch(
                websocket,
                socket.Connection(lifecycle=mock.sentinel.lifecycle),
                "team_1",
                {"type": "sync", "locale": "en"},
                authenticate,
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)
            await socket._dispatch(
                websocket,
                socket.Connection(lifecycle_proposal=mock.sentinel.proposal),
                "team_1",
                {"type": "stop"},
                authenticate,
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)
            with mock.patch.object(socket.task_resume, "dispatch", new=mock.AsyncMock()) as resume:
                await socket._dispatch(
                    websocket,
                    socket.Connection(lifecycle_proposal=mock.sentinel.proposal),
                    "team_1",
                    {"type": "resume-task"},
                    authenticate,
                )
            resume.assert_not_awaited()
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

        asyncio.run(scenario())

    def test_remaining_delivery_and_sync_failure_edges_are_terminal(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            websocket.send_json.side_effect = RuntimeError("closed")
            connection = socket.Connection()
            self.assertFalse(await socket._send_sync_event(websocket, connection, {"type": "sync-empty"}))
            self.assertTrue(connection.closed)

            websocket = mock.AsyncMock()
            detached = socket.Connection()
            await socket._deliver_turn(websocket, detached, socket.Turn(None, "chat"), "team_1")

            failure = local.PublicResponse(503, {"team_id": "team_1"})
            self.assertEqual(sync_delivery.pending_error(failure, "team_1", "human")["status"], 503)

            pending = _empty_integration_challenge()
            invalid_resumed = transport.TeamResponse(428, {"status": "integrations-required"})
            await sync_delivery.integration(
                websocket,
                socket.Connection(),
                "team_1",
                pending,
                invalid_resumed,
                socket._SYNC_OPERATIONS,
            )
            await sync_delivery.human(
                websocket,
                socket.Connection(),
                "team_1",
                failure,
                socket._SYNC_OPERATIONS,
            )

        asyncio.run(scenario())

    def test_sync_loader_and_delivery_cover_empty_closed_and_send_failure_results(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            with mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=None)):
                self.assertIsNone(await socket._load_sync_snapshot(websocket, socket.Connection(), "team_1", "en"))

            with mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(return_value=None)):
                await socket._deliver_sync(websocket, socket.Connection(), "team_1", "en")

            snapshot = socket.SyncSnapshot("human", object())
            with mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(return_value=snapshot)):
                await socket._deliver_sync(websocket, socket.Connection(closed=True), "team_1", "en")

            connection = socket.Connection()
            with (
                mock.patch.object(socket, "_load_sync_snapshot", new=mock.AsyncMock(side_effect=RuntimeError)),
                mock.patch.object(socket, "_send_sync_terminal_once", new=mock.AsyncMock(return_value=False)),
            ):
                await socket._deliver_sync(websocket, connection, "team_1", "en")
            self.assertTrue(connection.closed)

        asyncio.run(scenario())

    def test_stop_races_cover_noop_cancel_and_finished_pending_turn(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            response_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            response_future.set_result(local.PublicResponse(200, {"team_id": "team_1", "stopped": False}))
            turn = socket.Turn(None, "pending-stop")
            connection = socket.Connection(active=turn)
            with mock.patch.object(socket, "submit_in_context", return_value=response_future):
                await socket._run_stop(websocket, connection, turn, "team_1", emit=True)
            self.assertTrue(turn.terminal_sent)

            detached_turn = socket.Turn(None, "chat")
            await socket._finish_cancelled_turn(websocket, socket.Connection(), detached_turn)

            cancellable: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket.Turn(cancellable, "chat")
            self.assertIsNone(
                socket._request_stop(websocket, socket.Connection(active=turn), turn, "team_1", emit=False)
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
                    socket.Connection(),
                    "team_1",
                    future,
                    progress,
                    None,
                )
                await socket._deliver_human_response(
                    websocket,
                    socket.Connection(closed=True),
                    "team_1",
                    future,
                    progress,
                    None,
                )

            challenge = human_challenge("approval")
            connection = socket.Connection()
            with mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=challenge)):
                await socket._deliver_human_response(websocket, connection, "team_1", future, progress, None)
            self.assertEqual(connection.pending_challenge_type, "human")

            frame = human_response(True)
            busy = socket.Connection(active=socket.Turn(None, "chat"))
            await socket._dispatch_human_response(websocket, busy, "team_1", frame, authenticate)

            request = challenge.websocket_event("team_1")["request"]
            available = socket.Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=request,
            )
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
                await socket._dispatch_human_response(websocket, available, "team_1", frame, authenticate)

            blocked = socket.Connection(sync_task=mock.Mock(), sync_terminal_sent=True)
            await socket._dispatch_stop(websocket, blocked, "team_1")

        asyncio.run(scenario())

    def test_human_authentication_failure_edges_remain_fail_closed(self) -> None:
        async def unavailable(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("unavailable")

        async def denied(_kind: str, _secret: str) -> human.AuthenticationResult:
            return human.AuthenticationResult("denied", attempts_remaining=2)

        async def scenario() -> None:
            auth_request = human_challenge("auth:password").websocket_event("team_1")["request"]
            frame = human_response("password")
            payload, assurance, rejection, failure = await human.response_payload(
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
            completed = chat_socket_fixtures.completed_turn("Completed.")
            for result, field, expected in ((denied_response, "status", 503), (completed, "type", "done")):
                send_terminal = mock.AsyncMock(return_value=True)
                with (
                    self.subTest(field=field),
                    mock.patch.object(socket, "_await_progress_result", new=mock.AsyncMock(return_value=result)),
                    mock.patch.object(socket, "_send_sync_terminal_once", send_terminal),
                ):
                    await socket._deliver_human_response(
                        mock.AsyncMock(), socket.Connection(), "team_1", future, progress, failure
                    )
                    self.assertEqual(send_terminal.await_args.args[2][field], expected)

            pending = socket.Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=auth_request,
            )
            with mock.patch.object(socket, "_send_event", new=mock.AsyncMock(return_value=False)):
                await socket._dispatch_human_response(mock.AsyncMock(), pending, "team_1", dict(frame), denied)
            self.assertTrue(pending.closed)

            malformed = socket.Connection(
                pending_challenge_id="b" * 32,
                pending_challenge_type="human",
                pending_human_request=auth_request,
            )
            websocket = mock.AsyncMock()
            with mock.patch.object(
                socket.human,
                "response_payload",
                new=mock.AsyncMock(return_value=(None, None, None, None)),
            ):
                await socket._dispatch_human_response(websocket, malformed, "team_1", dict(frame), unavailable)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 503)

        asyncio.run(scenario())

    def test_channel_cleanup_accepts_an_already_finished_turn_without_tasks(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            future.set_result(object())
            transport = socket.Transport(mock.Mock(), mock.Mock())
            channel = socket.Channel(
                transport,
                "team_1",
                request_scope=contextlib.nullcontext,
                authenticate=mock.AsyncMock(return_value=human.AuthenticationResult("verified")),
                authorized=mock.AsyncMock(return_value=True),
            )
            channel.connection.active = socket.Turn(future, "chat")
            await channel.close()
            self.assertTrue(channel.connection.closed)
            # A closed channel admits no further frame.
            channel.submit({"type": "stop"})
            self.assertTrue(channel._frames.empty())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
