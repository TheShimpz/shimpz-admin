"""Focused security and lifecycle contracts for the local Admin chat WebSocket."""

import asyncio
import concurrent.futures
import threading
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

_MEASURED_PROGRESS = (
    {"origin": "admin", "phase": "admin-preparation", "state": "started"},
    {
        "origin": "admin",
        "phase": "admin-preparation",
        "state": "finished",
        "elapsed_ms": 5,
    },
    {"origin": "admin", "phase": "reply-validation", "state": "started"},
    {
        "origin": "admin",
        "phase": "reply-validation",
        "state": "finished",
        "elapsed_ms": 2,
    },
)


def _emit_measured_progress(callback) -> None:
    for event in _MEASURED_PROGRESS:
        callback(dict(event))


def _progress_frames() -> list[dict[str, object]]:
    return [
        {"type": "progress", "seq": sequence, **event} for sequence, event in enumerate(_MEASURED_PROGRESS, start=1)
    ]


_Socket = chat_socket_fixtures.Socket
_wait_for_thread = chat_socket_fixtures.wait_for_thread


class ChatWebSocketTests(ChatWebSocketCase):
    def test_origin_subprotocol_and_session_are_required_before_accept(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.admin_app, "_session_current", side_effect=AssertionError("auth must not run")):
                denied = _Socket(self.admin_app.app, origin="http://localhost:7777.evil.test")
                self.assertEqual(await denied.start(), {"type": "websocket.close", "code": 4403, "reason": ""})
                await denied.finish()

            wrong_protocol = _Socket(self.admin_app.app, token=self.token, protocols=["shimpz.chat.v1"])
            self.assertEqual(
                await wrong_protocol.start(),
                {"type": "websocket.close", "code": 4406, "reason": ""},
            )
            await wrong_protocol.finish()

            extra_protocol = _Socket(
                self.admin_app.app,
                token=self.token,
                protocols=["shimpz.chat.v7", "shimpz.chat.v6"],
            )
            self.assertEqual(
                await extra_protocol.start(),
                {"type": "websocket.close", "code": 4406, "reason": ""},
            )
            await extra_protocol.finish()

            anonymous = _Socket(self.admin_app.app)
            self.assertEqual(await anonymous.start(), {"type": "websocket.close", "code": 4401, "reason": ""})
            await anonymous.finish()

            authenticated = await self._open()
            await authenticated.disconnect()

        asyncio.run(scenario())

    def test_password_bound_external_origin_is_resolved_for_each_handshake(self) -> None:
        async def scenario() -> None:
            before = _Socket(
                self.admin_app.app,
                token=self.token,
                origin="https://developer.example.test",
            )
            self.assertEqual(await before.start(), {"type": "websocket.close", "code": 4403, "reason": ""})
            await before.finish()

            self.assertEqual(
                self.admin_app.state.bind_browser_origin("https://developer.example.test"),
                "learned",
            )
            admitted = await self._open(origin="https://developer.example.test")
            await admitted.disconnect()

            self.assertEqual(
                self.admin_app.state.bind_browser_origin("https://next.example.test"),
                "replaced",
            )
            stale = _Socket(
                self.admin_app.app,
                token=self.token,
                origin="https://developer.example.test",
            )
            self.assertEqual(await stale.start(), {"type": "websocket.close", "code": 4403, "reason": ""})
            await stale.finish()

        asyncio.run(scenario())

    def test_chat_frame_requires_one_exact_bounded_assistant_scope(self) -> None:
        async def scenario() -> None:
            websocket = await self._open()
            invalid_frames = (
                {"type": "chat", "message": "missing scope", "files": []},
                {
                    "type": "chat",
                    "message": "extra authority",
                    "files": [],
                    "assistant_ids": [],
                    "provider": "openai",
                },
                chat_socket_fixtures.chat_frame("duplicate", ["shimpz-cloudflare", "shimpz-cloudflare"]),
                chat_socket_fixtures.chat_frame("too many", [f"assistant-{index}" for index in range(17)]),
                chat_socket_fixtures.chat_frame("noncanonical", ["Shimpz-Assistant"]),
            )
            with mock.patch.object(self.chat_socket.local, "turn") as turn:
                for frame in invalid_frames:
                    await websocket.send_json(frame)
                    self.assertEqual((await websocket.next_json())["status"], 400)
                turn.assert_not_called()
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_session_is_revalidated_before_every_frame(self) -> None:
        async def scenario() -> None:
            websocket = await self._open()
            store = self.admin_app.state.get()
            store["session_secret"] = self.admin_app.auth.new_secret()
            self.admin_app.state._write(store)
            with mock.patch.object(self.chat_socket.local, "turn") as turn:
                await websocket.send_json(chat_socket_fixtures.chat_frame("must not run"))
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 4401, "reason": ""},
                )
                await websocket.finish()
                turn.assert_not_called()

        asyncio.run(scenario())

    def test_a_chat_operation_is_activity_and_an_idle_session_closes_its_socket(self) -> None:
        auth = self.admin_app.auth
        now = [0.0]

        async def scenario() -> None:
            websocket = await self._open()
            now[0] = auth.IDLE_SECONDS - 60
            await websocket.send_json({"type": "stop"})
            # A waiting socket rechecks its session and stays open while the session is current.
            await asyncio.sleep(0.3)
            now[0] = auth.IDLE_SECONDS + 60
            self.assertTrue(auth.SESSIONS.current(self.token, activity=False))
            now[0] = 2 * auth.IDLE_SECONDS
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()

        sessions = auth.SessionActivity(clock=lambda: now[0])
        sessions.register(self.token)
        with (
            mock.patch.object(auth, "SESSIONS", sessions),
            mock.patch.object(self.chat_socket, "SESSION_CHECK_SECONDS", 0.05),
        ):
            asyncio.run(scenario())

    def test_an_unattended_page_reconnecting_across_the_idle_deadline_is_closed(self) -> None:
        auth = self.admin_app.auth
        now = [0.0]

        async def scenario() -> None:
            websocket = await self._open()
            now[0] = auth.IDLE_SECONDS - 60
            # A reconnecting page sends sync on its own; it is checked against the session but does not renew it.
            await websocket.send_json({"type": "sync", "locale": "en"})
            await asyncio.sleep(0.3)
            now[0] = auth.IDLE_SECONDS + 60
            self.assertEqual(await self._closed(websocket), 4401)
            await websocket.finish()
            self.assertFalse(auth.SESSIONS.current(self.token, activity=False))

        sessions = auth.SessionActivity(clock=lambda: now[0])
        sessions.register(self.token)
        with (
            mock.patch.object(auth, "SESSIONS", sessions),
            mock.patch.object(self.chat_socket, "SESSION_CHECK_SECONDS", 0.05),
        ):
            asyncio.run(scenario())

    @staticmethod
    async def _closed(websocket) -> int:
        """Read past the socket's events to its close, returning the close code."""
        while (message := await websocket.next_message())["type"] != "websocket.close":
            pass
        return message["code"]

    def test_session_authority_unavailability_uses_retryable_close_code(self) -> None:
        async def scenario() -> None:
            unavailable = self.admin_app.SessionEvidenceUnavailableError()
            with mock.patch.object(
                self.admin_app,
                "_session_active",
                new=mock.AsyncMock(side_effect=unavailable),
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("must not run"))
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 1013, "reason": ""},
                )
                await websocket.finish()

        asyncio.run(scenario())

    def test_invalid_duplicate_and_oversized_frames_fail_closed(self) -> None:
        async def rejected_frame(text: str, event: dict, close_code: int) -> None:
            websocket = await self._open()
            await websocket.send_text(text)
            self.assertEqual(await websocket.next_json(), event)
            self.assertEqual(
                await websocket.next_message(),
                {"type": "websocket.close", "code": close_code, "reason": ""},
            )
            await websocket.finish()

        async def scenario() -> None:
            self.assertEqual(self.chat_socket.MAX_FRAME_BYTES, 128 * 1024)
            await rejected_frame(
                '{"type":"chat","message":"first","message":"second"}',
                {
                    "type": "error",
                    "status": 400,
                    "detail": "WebSocket frame must be valid unique-key JSON",
                },
                1007,
            )
            await rejected_frame(
                "x" * (self.chat_socket.MAX_FRAME_BYTES + 1),
                {"type": "error", "status": 413, "detail": "WebSocket frame too large"},
                1009,
            )

            binary = await self._open()
            await binary.send_bytes(b'{"type":"stop"}')
            self.assertEqual(
                await binary.next_json(),
                {"type": "error", "status": 415, "detail": "WebSocket frame must be text JSON"},
            )
            self.assertEqual(
                await binary.next_message(),
                {"type": "websocket.close", "code": 1003, "reason": ""},
            )
            await binary.finish()

        asyncio.run(scenario())

    def test_one_active_turn_and_stop_emit_exactly_one_terminal(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload, _conversation, _request, progress):
                started.set()
                release.wait(timeout=2)
                _emit_measured_progress(progress)
                return chat_socket_fixtures.completed_turn("late reply")

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn) as turn_mock,
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("first", ["shimpz-cloudflare"]))
                await _wait_for_thread(started)
                await websocket.send_json(chat_socket_fixtures.chat_frame("second"))
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "error", "status": 409, "detail": "a chat turn is already active"},
                )
                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                await websocket.send_json({"type": "stop"})
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                release.set()
                await asyncio.sleep(0.05)
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                await websocket.send_json(chat_socket_fixtures.chat_frame("next"))
                self.assertEqual(
                    [await websocket.next_json() for _index in range(4)],
                    _progress_frames(),
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(turn_mock.call_count, 2)
                await websocket.disconnect()
                turn_mock.assert_any_call(
                    "team_1",
                    {
                        "message": "first",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                        "locale": "en",
                        "timezone": None,
                    },
                    (),
                    mock.ANY,
                    mock.ANY,
                )
                self.assertEqual(stop_mock.call_count, 1)

        asyncio.run(scenario())

    def test_stop_race_preserves_the_completed_turn_when_controller_reports_not_stopped(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload, _conversation, _request, progress):
                started.set()
                release.wait(timeout=2)
                progress(dict(_MEASURED_PROGRESS[-1]))
                return chat_socket_fixtures.completed_turn("Natural terminal.")

            def stop(_team_id):
                release.set()
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "stopped": False},
                )

            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", side_effect=stop),
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("race"))
                await _wait_for_thread(started)
                await websocket.send_json({"type": "stop"})
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "progress", "seq": 1, **_MEASURED_PROGRESS[-1]},
                )
                self.assertEqual(
                    await websocket.next_json(),
                    chat_socket_fixtures.done_frame("Natural terminal."),
                )
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_blocked_stop_cannot_hold_a_completed_turn_terminal(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            finish_turn = threading.Event()
            finish_stop = threading.Event()

            def turn(_team_id, _payload, _conversation, _request, _progress):
                started.set()
                finish_turn.wait(timeout=2)
                return chat_socket_fixtures.completed_turn("Bounded terminal.")

            def stop(_team_id):
                finish_turn.set()
                finish_stop.wait(timeout=2)
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "stopped": True},
                )

            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", side_effect=stop),
                mock.patch.object(self.chat_socket, "STOP_RESULT_WAIT_SECONDS", 0.02),
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("bounded"))
                await _wait_for_thread(started)
                await websocket.send_json({"type": "stop"})
                self.assertEqual((await websocket.next_json())["type"], "done")
                finish_stop.set()
                await asyncio.sleep(0.05)
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_disconnect_stops_a_running_turn_once(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload, _conversation, _request, progress):
                started.set()
                release.wait(timeout=2)
                progress(dict(_MEASURED_PROGRESS[0]))
                return chat_socket_fixtures.completed_turn("discard me")

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("running"))
                await _wait_for_thread(started)
                await websocket.disconnect()
                self.assertEqual(stop_mock.call_count, 1)
                release.set()
                await asyncio.sleep(0.05)
                pending_getters = [
                    task
                    for task in asyncio.all_tasks()
                    if task is not asyncio.current_task() and not task.done() and "Queue.get" in repr(task.get_coro())
                ]
                self.assertEqual(pending_getters, [])

        asyncio.run(scenario())

    def test_progress_send_failure_stops_a_running_turn_once(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload, _conversation, _request, progress):
                started.set()
                progress(dict(_MEASURED_PROGRESS[0]))
                release.wait(timeout=2)
                return chat_socket_fixtures.completed_turn("discard me")

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = await self._open(fail_send_type="progress")
                await websocket.send_json(chat_socket_fixtures.chat_frame("running"))
                await _wait_for_thread(started)
                await _wait_for_thread(websocket.send_failed)
                await websocket.disconnect()
                self.assertEqual(stop_mock.call_count, 1)
                release.set()
                await asyncio.sleep(0.05)

        asyncio.run(scenario())

    def test_progress_send_failure_does_not_stop_a_completed_turn(self) -> None:
        async def scenario() -> None:
            def turn(_team_id, _payload, _conversation, _request, progress):
                progress(dict(_MEASURED_PROGRESS[0]))
                return chat_socket_fixtures.completed_turn("already committed")

            def submit_completed(_executor, function, /, *args, **kwargs):
                future = concurrent.futures.Future()
                future.set_result(function(*args, **kwargs))
                return future

            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket, "submit_in_context", side_effect=submit_completed),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
            ):
                websocket = await self._open(fail_send_type="progress")
                await websocket.send_json(chat_socket_fixtures.chat_frame("running"))
                await _wait_for_thread(websocket.send_failed)
                await websocket.disconnect()
                stop.assert_not_called()

        asyncio.run(scenario())

    def test_paused_integration_gate_survives_disconnect(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=chat_socket_fixtures.integration_challenge(),
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
            ):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("connect"))
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                self.assertIsNotNone(self.admin_app.chat_history.resumable_turn("team_1"))
                await websocket.disconnect()
                stop.assert_not_called()

        asyncio.run(scenario())

    def test_turn_emits_fixed_progress_before_its_single_terminal(self) -> None:
        async def scenario() -> None:
            def turn(_team_id, _payload, _conversation, _request, progress):
                _emit_measured_progress(progress)
                return chat_socket_fixtures.completed_turn("Done.")

            with mock.patch.object(self.chat_socket.local, "turn", side_effect=turn):
                websocket = await self._open()
                await websocket.send_json(chat_socket_fixtures.chat_frame("hello"))
                self.assertEqual(
                    [await websocket.next_json() for _index in range(4)],
                    _progress_frames(),
                )
                self.assertEqual(
                    await websocket.next_json(),
                    chat_socket_fixtures.done_frame("Done."),
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_completed_worker_flushes_its_scheduled_progress_before_returning(self) -> None:
        async def scenario() -> None:
            loop = asyncio.get_running_loop()
            response = loop.create_future()
            response.set_result("completed")
            progress: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            loop.call_soon(progress.put_nowait, dict(_MEASURED_PROGRESS[0]))
            websocket = mock.AsyncMock()
            connection = self.chat_socket._Connection()

            with mock.patch.object(self.chat_socket.progress_transport.asyncio, "wrap_future", return_value=response):
                result = await self.chat_socket._await_progress_result(
                    websocket,
                    connection,
                    mock.sentinel.worker_future,
                    progress,
                    lambda: False,
                )

            self.assertEqual(result, "completed")
            websocket.send_json.assert_awaited_once_with(
                {"type": "progress", "seq": 1, **_MEASURED_PROGRESS[0]},
            )

        asyncio.run(scenario())

    def test_failed_progress_delivery_observes_an_already_completed_worker(self) -> None:
        async def scenario() -> None:
            loop = asyncio.get_running_loop()
            response = loop.create_future()
            progress: asyncio.Queue[dict[str, object]] = asyncio.Queue()
            progress.put_nowait(dict(_MEASURED_PROGRESS[0]))
            connection = self.chat_socket._Connection()

            class FailingWebSocket:
                async def send_json(self, _event) -> None:
                    loop.call_soon(response.set_result, "completed")
                    raise RuntimeError("simulated peer send failure")

            with mock.patch.object(self.chat_socket.progress_transport.asyncio, "wrap_future", return_value=response):
                result = await self.chat_socket._await_progress_result(
                    FailingWebSocket(),
                    connection,
                    mock.sentinel.worker_future,
                    progress,
                    lambda: False,
                )

            self.assertEqual(result, "completed")
            self.assertTrue(connection.closed)

        asyncio.run(scenario())
