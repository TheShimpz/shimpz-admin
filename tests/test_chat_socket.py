"""Focused security and lifecycle contracts for the local Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import chat_socket_fixtures
from mfa_helper import configure_supervisor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

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


class ChatWebSocketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        cls.root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(cls.root),
                "SHIMPZ_ADMIN_STORE": str(cls.root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            cls.admin_app = importlib.import_module("app")
        cls.chat_socket = importlib.import_module("chat.socket")
        cls.assistant_plan = importlib.import_module("chat.assistant_plan")
        cls.team = importlib.import_module("team.bridge")
        previous_store = cls.admin_app.state.STORE_PATH
        previous_origins = cls.chat_socket.STATIC_ORIGINS
        cls.admin_app.state.STORE_PATH = cls.root / "admin.json"
        cls.chat_socket.STATIC_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.chat_socket, "STATIC_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        secret = configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        self.token = self.admin_app.auth.issue_session(secret, "totp")

    def _install_candidate(self):
        return self.chat_socket.lifecycle.store_catalog.CatalogAssistant(
            assistant_id="shimpz-cloudflare",
            name="Shimpz Cloudflare",
            summary="Manage Cloudflare zones and DNS records.",
            source_digest="sha256:" + ("d" * 64),
            icon_digest="sha256:" + ("e" * 64),
            integrations=(
                self.chat_socket.lifecycle.store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),
            ),
            actions=("list-zones",),
        )

    def _whatsapp_candidate(self):
        return self.chat_socket.lifecycle.store_catalog.CatalogAssistant(
            assistant_id="whatsapp",
            name="WhatsApp",
            summary="Send reviewed WhatsApp messages.",
            source_digest="sha256:" + ("a" * 64),
            icon_digest="sha256:" + ("b" * 64),
            integrations=(
                self.chat_socket.lifecycle.store_catalog.CatalogIntegration("whatsapp", ("messages.write",)),
            ),
            actions=("send-message",),
        )

    def _automatic_plan(self):
        assistants = (self._install_candidate(), self._whatsapp_candidate())
        return self.assistant_plan.Plan(
            "f" * 32,
            "team_1",
            assistants,
            ("already-enabled", "shimpz-cloudflare", "whatsapp"),
        )

    @staticmethod
    def _future(value):
        future = concurrent.futures.Future()
        future.set_result(value)
        return future

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v7", "headers": []}

    def test_origin_subprotocol_and_session_are_required_before_accept(self) -> None:
        async def scenario() -> None:
            with mock.patch.object(self.admin_app, "_session_ok", side_effect=AssertionError("auth must not run")):
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

            authenticated = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await authenticated.start()))
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
            admitted = _Socket(
                self.admin_app.app,
                token=self.token,
                origin="https://developer.example.test",
            )
            self.assertTrue(self._accepted(await admitted.start()))
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
            websocket = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await websocket.start()))
            invalid_frames = (
                {"type": "chat", "message": "missing scope", "files": []},
                {
                    "type": "chat",
                    "message": "extra authority",
                    "files": [],
                    "assistant_ids": [],
                    "provider": "openai",
                },
                {
                    "type": "chat",
                    "message": "duplicate",
                    "files": [],
                    "assistant_ids": ["shimpz-cloudflare", "shimpz-cloudflare"],
                },
                {
                    "type": "chat",
                    "message": "too many",
                    "files": [],
                    "assistant_ids": [f"assistant-{index}" for index in range(17)],
                },
                {
                    "type": "chat",
                    "message": "noncanonical",
                    "files": [],
                    "assistant_ids": ["Shimpz-Assistant"],
                },
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
            websocket = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await websocket.start()))
            store = self.admin_app.state.get()
            store["session_secret"] = self.admin_app.auth.new_secret()
            self.admin_app.state._write(store)
            with mock.patch.object(self.chat_socket.local, "turn") as turn:
                await websocket.send_json({"type": "chat", "message": "must not run", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 4401, "reason": ""},
                )
                await websocket.finish()
                turn.assert_not_called()

        asyncio.run(scenario())

    def test_session_authority_unavailability_uses_retryable_close_code(self) -> None:
        async def scenario() -> None:
            unavailable = self.admin_app.SessionEvidenceUnavailableError()
            with mock.patch.object(
                self.admin_app,
                "_session_ok",
                new=mock.AsyncMock(side_effect=[True, unavailable]),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "must not run", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 1013, "reason": ""},
                )
                await websocket.finish()

        asyncio.run(scenario())

    def test_invalid_duplicate_and_oversized_frames_fail_closed(self) -> None:
        async def rejected_frame(text: str, event: dict, close_code: int) -> None:
            websocket = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await websocket.start()))
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

            binary = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await binary.start()))
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

            def turn(_team_id, _payload, progress):
                started.set()
                release.wait(timeout=2)
                _emit_measured_progress(progress)
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "late reply"},
                )

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn) as turn_mock,
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "first",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
                await _wait_for_thread(started)
                await websocket.send_json({"type": "chat", "message": "second", "files": [], "assistant_ids": []})
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
                await websocket.send_json({"type": "chat", "message": "next", "files": [], "assistant_ids": []})
                self.assertEqual(
                    [await websocket.next_json() for _index in range(4)],
                    _progress_frames(),
                )
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(turn_mock.call_count, 2)
                await websocket.disconnect()
                turn_mock.assert_any_call(
                    "team_1",
                    {"message": "first", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
                    mock.ANY,
                )
                self.assertEqual(stop_mock.call_count, 1)

        asyncio.run(scenario())

    def test_stop_race_preserves_the_completed_turn_when_controller_reports_not_stopped(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload, progress):
                started.set()
                release.wait(timeout=2)
                progress(dict(_MEASURED_PROGRESS[-1]))
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "Natural terminal."},
                )

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
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "race", "files": [], "assistant_ids": []})
                await _wait_for_thread(started)
                await websocket.send_json({"type": "stop"})
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "progress", "seq": 1, **_MEASURED_PROGRESS[-1]},
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Natural terminal.",
                    },
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

            def turn(_team_id, _payload, _progress):
                started.set()
                finish_turn.wait(timeout=2)
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "Bounded terminal."},
                )

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
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "bounded", "files": [], "assistant_ids": []})
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

            def turn(_team_id, _payload, progress):
                started.set()
                release.wait(timeout=2)
                progress(dict(_MEASURED_PROGRESS[0]))
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "discard me"},
                )

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "running", "files": [], "assistant_ids": []})
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

            def turn(_team_id, _payload, progress):
                started.set()
                progress(dict(_MEASURED_PROGRESS[0]))
                release.wait(timeout=2)
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "discard me"},
                )

            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token, fail_send_type="progress")
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "running", "files": [], "assistant_ids": []})
                await _wait_for_thread(started)
                await _wait_for_thread(websocket.send_failed)
                await websocket.disconnect()
                self.assertEqual(stop_mock.call_count, 1)
                release.set()
                await asyncio.sleep(0.05)

        asyncio.run(scenario())

    def test_progress_send_failure_does_not_stop_a_completed_turn(self) -> None:
        async def scenario() -> None:
            def turn(_team_id, _payload, progress):
                progress(dict(_MEASURED_PROGRESS[0]))
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "already committed"},
                )

            def submit_completed(_executor, function, /, *args, **kwargs):
                future = concurrent.futures.Future()
                future.set_result(function(*args, **kwargs))
                return future

            with (
                mock.patch.object(self.chat_socket.local, "turn", side_effect=turn),
                mock.patch.object(self.chat_socket, "submit_in_context", side_effect=submit_completed),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token, fail_send_type="progress")
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "running", "files": [], "assistant_ids": []})
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
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "connect", "files": [], "assistant_ids": []})
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                await websocket.disconnect()
                stop.assert_not_called()

        asyncio.run(scenario())

    def test_turn_emits_fixed_progress_before_its_single_terminal(self) -> None:
        async def scenario() -> None:
            def turn(_team_id, _payload, progress):
                _emit_measured_progress(progress)
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "Done."},
                )

            with mock.patch.object(self.chat_socket.local, "turn", side_effect=turn):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "hello", "files": [], "assistant_ids": []})
                self.assertEqual(
                    [await websocket.next_json() for _index in range(4)],
                    _progress_frames(),
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Done.",
                    },
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

    def test_automatic_composed_plan_installs_then_dispatches_the_original_task_once(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            installed = tuple(
                {**item, "status": "installed"}
                for item in self.assistant_plan.initial_items(plan)
            )
            preparation = self._future(self.assistant_plan.Preparation(plan))
            job = self._future(self.assistant_plan.Result("installed", installed))
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Task complete."},
            )
            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_preparation", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", return_value=job) as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )

                planned = await websocket.next_json()
                completed = await websocket.next_json()
                done = await websocket.next_json()

                self.assertEqual((planned["type"], planned["state"]), ("assistant-install-plan", "planned"))
                self.assertEqual((completed["type"], completed["state"]), ("assistant-install-plan", "installed"))
                self.assertEqual(done["type"], "done")
                self.assertNotIn("source_digest", json.dumps((planned, completed)))
                submit_plan.assert_called_once()
                self.assertIs(submit_plan.call_args.args[0], plan)
                self.assertEqual(turn.call_count, 1)
                dispatched = turn.call_args.args[1]
                self.assertEqual(dispatched["message"], "Configure Cloudflare e envie WhatsApp")
                self.assertEqual(
                    dispatched["assistant_ids"],
                    ["already-enabled", "shimpz-cloudflare", "whatsapp"],
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_no_capability_gap_dispatches_directly_without_a_plan_event(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Done."},
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=self._future(self.assistant_plan.Preparation()),
                ),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan") as submit_plan,
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "Resuma esta conversa", "files": [], "assistant_ids": []}
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Done.",
                    },
                )
                submit_plan.assert_not_called()
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_partial_plan_failure_never_dispatches_the_task_or_rolls_back_success(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            items = list(self.assistant_plan.initial_items(plan))
            items[0] = {**items[0], "status": "installed"}
            items[1] = {**items[1], "status": "failed"}
            preparation = self._future(self.assistant_plan.Preparation(plan))
            job = self._future(
                self.assistant_plan.Result("failed", tuple(items), 503)
            )
            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_preparation", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", return_value=job),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                failed = await websocket.next_json()
                self.assertEqual((failed["type"], failed["state"], failed["status"]), (
                    "assistant-install-plan",
                    "failed",
                    503,
                ))
                self.assertEqual(
                    [item["status"] for item in failed["assistants"]],
                    ["installed", "failed"],
                )
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_stop_during_a_plan_prevents_the_next_item_and_task_dispatch(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            preparation = self._future(self.assistant_plan.Preparation(plan))
            job: concurrent.futures.Future = concurrent.futures.Future()
            worker_finished = threading.Event()

            def submit(_plan, stopped, _progress):
                def finish() -> None:
                    stopped.wait(timeout=2)
                    items = list(self.assistant_plan.initial_items(plan))
                    items[0] = {**items[0], "status": "installed"}
                    job.set_result(self.assistant_plan.Result("stopped", tuple(items)))
                    worker_finished.set()

                threading.Thread(target=finish, daemon=True).start()
                return job

            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_preparation", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", side_effect=submit),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                await websocket.send_json({"type": "stop"})
                stopped = await websocket.next_json()
                self.assertEqual((stopped["type"], stopped["state"]), ("assistant-install-plan", "stopped"))
                self.assertEqual(
                    [item["status"] for item in stopped["assistants"]],
                    ["installed", "pending"],
                )
                await _wait_for_thread(worker_finished)
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_completed_plan_continues_into_the_team_owned_integration_gate(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            items = tuple(
                {**item, "status": "installed"}
                for item in self.assistant_plan.initial_items(plan)
            )
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=self._future(self.assistant_plan.Preparation(plan)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    return_value=self._future(self.assistant_plan.Result("installed", items)),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    return_value=chat_socket_fixtures.integration_challenge(),
                ) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                self.assertEqual((await websocket.next_json())["state"], "installed")
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_disconnect_discards_unstarted_plan_items_and_never_replays_the_task(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            preparation = self._future(self.assistant_plan.Preparation(plan))
            job: concurrent.futures.Future = concurrent.futures.Future()
            stopped_seen = threading.Event()

            def submit(_plan, stopped, _progress):
                def finish() -> None:
                    stopped.wait(timeout=2)
                    stopped_seen.set()
                    job.set_result(
                        self.assistant_plan.Result(
                            "stopped",
                            self.assistant_plan.initial_items(plan),
                        )
                    )

                threading.Thread(target=finish, daemon=True).start()
                return job

            with (
                mock.patch.object(self.chat_socket.lifecycle, "submit_preparation", return_value=preparation),
                mock.patch.object(self.chat_socket.lifecycle, "submit_plan", side_effect=submit),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                await websocket.disconnect()
                await _wait_for_thread(stopped_seen)
                turn.assert_not_called()

                reconnect = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await reconnect.start()))
                await asyncio.sleep(0)
                turn.assert_not_called()
                await reconnect.disconnect()

        asyncio.run(scenario())

    def test_plan_capacity_failure_happens_after_projection_but_before_team_dispatch(self) -> None:
        async def scenario() -> None:
            plan = self._automatic_plan()
            with (
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_preparation",
                    return_value=self._future(self.assistant_plan.Preparation(plan)),
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_plan",
                    side_effect=self.chat_socket.ExecutorSaturatedError,
                ),
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Configure Cloudflare e envie WhatsApp",
                        "files": [],
                        "assistant_ids": ["already-enabled"],
                    }
                )
                self.assertEqual((await websocket.next_json())["state"], "planned")
                failed = await websocket.next_json()
                self.assertEqual((failed["state"], failed["status"]), ("failed", 429))
                self.assertTrue(all(item["status"] == "pending" for item in failed["assistants"]))
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
