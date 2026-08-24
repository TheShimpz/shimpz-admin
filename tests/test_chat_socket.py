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


class _Socket:
    def __init__(
        self,
        application,
        *,
        token: str = "",
        origin: str = "http://localhost:7777",
        protocols: list[str] | None = None,
        team_id: str = "team_1",
        fail_send_type: str = "",
    ) -> None:
        offered = ["shimpz.chat.v5"] if protocols is None else protocols
        headers = [(b"host", b"localhost:7777"), (b"origin", origin.encode("ascii"))]
        if offered:
            headers.append((b"sec-websocket-protocol", ", ".join(offered).encode("ascii")))
        if token:
            headers.append((b"cookie", f"shimpz_admin={token}".encode("ascii")))
        path = f"/api/teams/{team_id}/chat/ws"
        self._scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 7777),
            "subprotocols": offered,
            "state": {},
            "extensions": {},
        }
        self._application = application
        self._incoming: asyncio.Queue = asyncio.Queue()
        self._outgoing: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._fail_send_type = fail_send_type
        self.send_failed = threading.Event()

    async def _send(self, message: dict) -> None:
        if message.get("type") == "websocket.send" and "text" in message:
            event = json.loads(message["text"])
            if event.get("type") == self._fail_send_type:
                self.send_failed.set()
                raise RuntimeError("simulated peer send failure")
        await self._outgoing.put(message)

    async def start(self) -> dict:
        self._task = asyncio.create_task(self._application(self._scope, self._incoming.get, self._send))
        await self._incoming.put({"type": "websocket.connect"})
        return await self.next_message()

    async def next_message(self, wait_seconds: float = 1.0) -> dict:
        return await asyncio.wait_for(self._outgoing.get(), timeout=wait_seconds)

    async def next_json(self, wait_seconds: float = 1.0) -> dict:
        message = await self.next_message(wait_seconds)
        if message.get("type") != "websocket.send" or "text" not in message:
            raise AssertionError(f"expected a text WebSocket frame, got {message!r}")
        return json.loads(message["text"])

    async def send_text(self, text: str) -> None:
        await self._incoming.put({"type": "websocket.receive", "text": text})

    async def send_bytes(self, value: bytes) -> None:
        await self._incoming.put({"type": "websocket.receive", "bytes": value})

    async def send_json(self, value: object) -> None:
        await self.send_text(json.dumps(value, separators=(",", ":")))

    async def disconnect(self) -> None:
        await self._incoming.put({"type": "websocket.disconnect", "code": 1000})
        await self.finish()

    async def finish(self) -> None:
        if self._task is not None:
            await asyncio.wait_for(self._task, timeout=2)


async def _wait_for_thread(event: threading.Event, wait_seconds: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while not event.is_set():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("worker did not start")
        await asyncio.sleep(0.005)


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
        return self.chat_socket.install_flow.store_catalog.CatalogAssistant(
            assistant_id="shimpz-cloudflare",
            name="Shimpz Cloudflare",
            summary="Manage Cloudflare zones and DNS records.",
            source_digest="sha256:" + ("d" * 64),
            integrations=(
                self.chat_socket.install_flow.store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),
            ),
            actions=("list-zones",),
        )

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v5", "headers": []}

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
                protocols=["shimpz.chat.v5", "shimpz.chat.v4"],
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

    def test_successful_turn_can_propose_one_socket_scoped_install_without_a_digest(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "I can help with that."},
            )
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    return_value=self._install_candidate(),
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Liste minhas zonas DNS da Cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                event = await websocket.next_json()
                self.assertEqual(event["type"], "assistant-install")
                self.assertEqual(event["state"], "proposed")
                self.assertEqual(event["team_id"], "team_1")
                self.assertEqual(event["reply"], "I can help with that.")
                self.assertEqual(event["expires_in"], 300)
                self.assertEqual(
                    event["assistant"],
                    {
                        "id": "shimpz-cloudflare",
                        "name": "Shimpz Cloudflare",
                        "summary": "Manage Cloudflare zones and DNS records.",
                        "providers": ["cloudflare"],
                    },
                )
                self.assertRegex(event["proposal_id"], r"^[0-9a-f]{32}$")
                self.assertNotIn("source_digest", json.dumps(event))
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_text_confirmation_consumes_proposal_and_installs_once(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready."},
            )
            result = self.chat_socket.install_flow.assistant_install.InstallResult(200, True)
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    side_effect=(self._install_candidate(), None),
                ),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "install",
                    return_value=result,
                ) as install,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "Cloudflare zones", "files": [], "assistant_ids": []}
                )
                proposed = await websocket.next_json()

                await websocket.send_json(
                    {"type": "chat", "message": "Pode instalar!", "files": [], "assistant_ids": []}
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-install",
                        "state": "installing",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                    },
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-install",
                        "state": "installed",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                        "team_id": "team_1",
                        "installed": True,
                    },
                )
                install.assert_called_once()
                proposal = install.call_args.args[0]
                self.assertEqual(proposal.assistant.source_digest, "sha256:" + ("d" * 64))
                self.assertEqual(turn.call_count, 1)

                await websocket.send_json({"type": "chat", "message": "sim", "files": [], "assistant_ids": []})
                self.assertEqual((await websocket.next_json())["type"], "done")
                self.assertEqual(turn.call_count, 2)
                install.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_negative_cancels_and_ambiguous_message_retires_proposal(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Understood."},
            )
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    side_effect=(self._install_candidate(), self._install_candidate(), None),
                ),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "install",
                    return_value=self.chat_socket.install_flow.assistant_install.InstallResult(200, True),
                ) as install,
            ):
                cancelled = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await cancelled.start()))
                await cancelled.send_json({"type": "chat", "message": "Cloudflare", "files": [], "assistant_ids": []})
                proposed = await cancelled.next_json()
                await cancelled.send_json({"type": "chat", "message": "Esquece", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await cancelled.next_json(),
                    {
                        "type": "assistant-install",
                        "state": "cancelled",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                    },
                )
                await cancelled.disconnect()

                ambiguous = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await ambiguous.start()))
                await ambiguous.send_json({"type": "chat", "message": "Cloudflare", "files": [], "assistant_ids": []})
                await ambiguous.next_json()
                await ambiguous.send_json(
                    {"type": "chat", "message": "talvez depois", "files": [], "assistant_ids": []}
                )
                self.assertEqual((await ambiguous.next_json())["type"], "done")
                install.assert_not_called()
                await ambiguous.send_json({"type": "chat", "message": "ok", "files": [], "assistant_ids": []})
                self.assertEqual((await ambiguous.next_json())["type"], "done")
                await ambiguous.disconnect()

                self.assertEqual(turn.call_count, 4)
                install.assert_not_called()

        asyncio.run(scenario())

    def test_team_challenge_supersedes_a_pending_install_proposal(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready."},
            )
            stopped = self.chat_socket.local.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "turn",
                    side_effect=(response, chat_socket_fixtures.integration_challenge()),
                ),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    return_value=self._install_candidate(),
                ),
                mock.patch.object(self.chat_socket.local, "stop", return_value=stopped) as stop,
                mock.patch.object(self.chat_socket.install_flow.assistant_install, "install") as install,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "Cloudflare", "files": [], "assistant_ids": []})
                self.assertEqual((await websocket.next_json())["state"], "proposed")
                await websocket.send_json(
                    {"type": "chat", "message": "talvez depois", "files": [], "assistant_ids": []}
                )
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")

                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                stop.assert_called_once()
                install.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_expired_confirmation_never_reaches_install_authority(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready."},
            )
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    return_value=self._install_candidate(),
                ),
                mock.patch.object(self.chat_socket.install_flow.assistant_install, "install") as install,
                mock.patch.object(self.chat_socket.install_flow, "monotonic", side_effect=(10, 311)),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "Cloudflare", "files": [], "assistant_ids": []})
                proposed = await websocket.next_json()
                await websocket.send_json({"type": "chat", "message": "sim", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-install",
                        "state": "expired",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                    },
                )
                install.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_install_capacity_failure_consumes_proposal_without_reaching_team(self) -> None:
        async def scenario() -> None:
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready."},
            )
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response),
                mock.patch.object(
                    self.chat_socket.install_flow.assistant_install,
                    "discover",
                    return_value=self._install_candidate(),
                ),
                mock.patch.object(self.chat_socket.install_flow.assistant_install, "install") as install,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "Cloudflare", "files": [], "assistant_ids": []})
                proposed = await websocket.next_json()

                with mock.patch.object(
                    self.chat_socket.install_flow._INSTALL_EXECUTOR,
                    "submit",
                    side_effect=self.chat_socket.ExecutorSaturatedError,
                ):
                    await websocket.send_json({"type": "chat", "message": "ok", "files": [], "assistant_ids": []})
                    self.assertEqual((await websocket.next_json())["state"], "installing")
                    self.assertEqual(
                        await websocket.next_json(),
                        {
                            "type": "assistant-install",
                            "state": "failed",
                            "proposal_id": proposed["proposal_id"],
                            "assistant_id": "shimpz-cloudflare",
                            "status": 429,
                        },
                    )

                install.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())
