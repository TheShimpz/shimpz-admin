"""Cancellation, saturation, and delivery edges for the Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from chat.delivery import plan as plan_delivery
from chat.delivery import sync as sync_delivery
from team import bridge as team
from tests.chat_socket_fixtures import human_challenge

from chat import assistant_route, human, local, socket, task_resume


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


class ChatSocketEdgeTests(unittest.TestCase):
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
                        assistant_route.Result("assistant-uninstall")
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
                {"type": "assistant-uninstall", "state": "target-required", "team_id": "team_1"},
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
                        assistant_route.Result("assistant-uninstall")
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

    def test_continuation_stop_saturation_and_detached_finish_are_terminal(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            turn = socket._Turn(None, "capability-plan", stop_requested=True)
            connection = socket._Connection(active=turn)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()) as send:
                await socket._continue_team_turn(websocket, connection, turn, "team_1", {})
            send.assert_awaited_once()
            self.assertIsNone(connection.active)

            turn = socket._Turn(None, "capability-plan")
            connection = socket._Connection(active=turn)
            with (
                mock.patch.object(socket, "_submit_team_turn", side_effect=socket.ExecutorSaturatedError),
                mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()) as send,
            ):
                await socket._continue_team_turn(websocket, connection, turn, "team_1", {})
            self.assertEqual(send.await_args.args[-1]["status"], 429)
            self.assertIsNone(connection.active)

            active = socket._Turn(None, "chat")
            detached = socket._Turn(None, "capability-plan", stop_requested=True)
            connection = socket._Connection(active=active)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()):
                await socket._continue_team_turn(websocket, connection, detached, "team_1", {})
            self.assertIs(connection.active, active)

            detached = socket._Turn(None, "capability-plan")
            with (
                mock.patch.object(socket, "_submit_team_turn", side_effect=socket.ExecutorSaturatedError),
                mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()),
            ):
                await socket._continue_team_turn(websocket, connection, detached, "team_1", {})
            self.assertIs(connection.active, active)

            detached = socket._Turn(None, "chat")
            connection = socket._Connection(active=active)
            with mock.patch.object(socket, "_send_terminal_once", new=mock.AsyncMock()):
                await socket._finish_active_turn(websocket, connection, detached, {"type": "done"})
            self.assertIs(connection.active, active)

        asyncio.run(scenario())

    def test_lifecycle_stop_cancels_nonplan_work_and_emits_once(self) -> None:
        async def scenario() -> None:
            future: concurrent.futures.Future[object] = concurrent.futures.Future()
            turn = socket._Turn(future, "chat", lifecycle_stop=threading.Event())
            connection = socket._Connection(active=turn)
            task = socket._request_stop(mock.AsyncMock(), connection, turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            self.assertTrue(future.cancelled())
            self.assertTrue(turn.lifecycle_stop.is_set())
            await task

            turn = socket._Turn(None, "chat", lifecycle_stop=threading.Event())
            task = socket._request_stop(mock.AsyncMock(), socket._Connection(active=turn), turn, "team_1", emit=True)
            self.assertIsNotNone(task)
            await task

            future = concurrent.futures.Future()
            turn = socket._Turn(future, "chat", lifecycle_stop=threading.Event())
            self.assertIsNone(
                socket._request_stop(
                    mock.AsyncMock(),
                    socket._Connection(active=turn),
                    turn,
                    "team_1",
                    emit=False,
                )
            )
            self.assertTrue(future.cancelled())

        asyncio.run(scenario())

    def test_direct_start_and_route_saturation_are_bounded(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with mock.patch.object(socket, "_submit_team_turn", side_effect=socket.ExecutorSaturatedError):
                await socket._start_direct_turn(websocket, connection, "team_1", {}, None)
            self.assertIsNone(connection.active)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 429)

            frame = {"type": "chat", "message": "hello", "files": [], "assistant_ids": []}
            websocket.reset_mock()
            with (
                mock.patch.object(socket.lifecycle, "resolve", new=mock.AsyncMock(return_value=False)),
                mock.patch.object(
                    socket.lifecycle,
                    "submit_route",
                    side_effect=socket.ExecutorSaturatedError,
                ),
            ):
                await socket._dispatch_chat(websocket, socket._Connection(), "team_1", frame)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 429)

        asyncio.run(scenario())

    def test_resume_task_admission_is_exact_and_authoritatively_revalidated(self) -> None:
        valid = {
            "type": "resume-task",
            "message": "Você mesmo consegue habilitar?",
            "objective": "Lista minhas zonas DNS no Cloudflare",
            "files": [],
            "assistant_ids": [],
            "objective_assistant_ids": [],
        }

        async def scenario() -> None:
            websocket = mock.AsyncMock()
            admitted = await task_resume.admit(
                websocket,
                socket._Connection(),
                valid,
                _resume_operations(),
            )
            self.assertEqual(
                admitted,
                (
                    {"message": valid["message"], "files": [], "assistant_ids": []},
                    {"message": valid["objective"], "files": [], "assistant_ids": []},
                ),
            )
            websocket.send_json.assert_not_awaited()

            invalid = (
                {**valid, "extra": True},
                {**valid, "files": ["a" * 32]},
                {**valid, "assistant_ids": ["whatsapp"]},
                {**valid, "message": "como faço para habilitar o modo escuro"},
                {**valid, "objective": "pode habilitar"},
            )
            for frame in invalid:
                websocket.reset_mock()
                self.assertIsNone(
                    await task_resume.admit(
                        websocket,
                        socket._Connection(),
                        frame,
                        _resume_operations(),
                    )
                )
                self.assertEqual(websocket.send_json.await_args.args[0]["status"], 400)

            websocket.reset_mock()
            self.assertIsNone(
                await task_resume.admit(
                    websocket,
                    socket._Connection(active=socket._Turn(None, "chat")),
                    valid,
                    _resume_operations(),
                )
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

            websocket.reset_mock()
            self.assertIsNone(
                await task_resume.admit(
                    websocket,
                    socket._Connection(pending_challenge_id="c" * 32),
                    valid,
                    _resume_operations(),
                )
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

            websocket.reset_mock()
            with mock.patch.object(socket.lifecycle, "submit_resume") as prepare:
                await task_resume.dispatch(
                    websocket,
                    socket._Connection(),
                    "team_1",
                    {**valid, "extra": True},
                    _resume_operations(),
                )
            prepare.assert_not_called()
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 400)

        asyncio.run(scenario())

    def test_resume_task_plans_the_prior_objective_without_semantic_fallback(self) -> None:
        frame = {
            "type": "resume-task",
            "message": "Você mesmo consegue habilitar?",
            "objective": "Lista minhas zonas DNS no Cloudflare",
            "files": [],
            "assistant_ids": [],
            "objective_assistant_ids": [],
        }

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
                    socket._Connection(),
                    "team_1",
                    frame,
                    _resume_operations(),
                )
            objective = {"message": frame["objective"], "files": [], "assistant_ids": []}
            prepare.assert_called_once_with("team_1", objective)
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 429)

            preparation: concurrent.futures.Future[object] = concurrent.futures.Future()
            deliver = mock.AsyncMock()
            connection = socket._Connection()
            with (
                mock.patch.object(socket.lifecycle, "submit_resume", return_value=preparation),
                mock.patch.object(socket.route_delivery, "deliver", new=deliver),
            ):
                await task_resume.dispatch(
                    websocket,
                    connection,
                    "team_1",
                    frame,
                    _resume_operations(),
                )
                await connection.active.delivery
            deliver.assert_awaited_once_with(
                websocket,
                connection,
                connection.active,
                "team_1",
                objective,
                mock.ANY,
                fallback_payload={"message": frame["message"], "files": [], "assistant_ids": []},
            )

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
            mock.patch.dict(socket.socket_boundary.os.environ, {"SHIMPZ_ADMIN_ALLOWED_ORIGINS": "bad"}),
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
            await sync_delivery.integration(
                websocket, connection, "team_1", empty, None, socket._SYNC_OPERATIONS
            )
            self.assertIsNone(connection.pending_challenge_id)

            connection = socket._Connection()
            await sync_delivery.integration(
                websocket, connection, "team_1", object(), None, socket._SYNC_OPERATIONS
            )
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
            await sync_delivery.integration(
                websocket, connection, "team_1", pending, None, socket._SYNC_OPERATIONS
            )
            self.assertTrue(connection.sync_terminal_sent)

            connection = socket._Connection()
            await sync_delivery.human(websocket, connection, "team_1", empty, socket._SYNC_OPERATIONS)
            self.assertIsNone(connection.pending_challenge_id)

        asyncio.run(scenario())

    def test_sync_load_stop_and_dispatch_saturation_are_projected(self) -> None:
        async def scenario() -> None:
            websocket = mock.AsyncMock()
            connection = socket._Connection()
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
                self.assertIsNone(await socket._load_sync_snapshot(websocket, connection, "team_1"))
            self.assertTrue(connection.sync_terminal_sent)

            turn = socket._Turn(None, "pending-stop")
            connection = socket._Connection(active=turn)
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
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

            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
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
            pending = socket._Connection(
                pending_challenge_id="a" * 32,
                pending_history_id="a" * 32,
            )
            await socket._dispatch_stop(websocket, pending, "team_1")
            self.assertIsNotNone(pending.active)

            await socket._dispatch(websocket, socket._Connection(), "team_1", {"type": "bad"}, authenticate)
            await socket._dispatch(
                websocket,
                socket._Connection(lifecycle=mock.sentinel.lifecycle),
                "team_1",
                {"type": "sync"},
                authenticate,
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)
            await socket._dispatch(
                websocket,
                socket._Connection(lifecycle_proposal=mock.sentinel.proposal),
                "team_1",
                {"type": "stop"},
                authenticate,
            )
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)
            with mock.patch.object(socket.task_resume, "dispatch", new=mock.AsyncMock()) as resume:
                await socket._dispatch(
                    websocket,
                    socket._Connection(lifecycle_proposal=mock.sentinel.proposal),
                    "team_1",
                    {"type": "resume-task"},
                    authenticate,
                )
            resume.assert_not_awaited()
            self.assertEqual(websocket.send_json.await_args.args[0]["status"], 409)

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
            self.assertEqual(sync_delivery.pending_error(failure, "team_1", "human")["status"], 503)

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
            await sync_delivery.integration(
                websocket,
                socket._Connection(),
                "team_1",
                pending,
                invalid_resumed,
                socket._SYNC_OPERATIONS,
            )
            await sync_delivery.human(
                websocket,
                socket._Connection(),
                "team_1",
                failure,
                socket._SYNC_OPERATIONS,
            )

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
            with mock.patch.object(socket, "submit_in_context", return_value=response_future):
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
            with mock.patch.object(socket, "submit_in_context", side_effect=socket.ExecutorSaturatedError):
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
                socket.human,
                "response_payload",
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
