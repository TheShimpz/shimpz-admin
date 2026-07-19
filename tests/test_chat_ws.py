"""Focused security and lifecycle contracts for the local Admin chat WebSocket."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import uvicorn
import websockets
from websockets.exceptions import InvalidStatus

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class _Socket:
    def __init__(
        self,
        application,
        *,
        token: str = "",
        origin: str = "http://localhost:7777",
        protocols: list[str] | None = None,
        team_id: str = "team_1",
    ) -> None:
        offered = ["shimpz.chat.v2"] if protocols is None else protocols
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

    async def start(self) -> dict:
        self._task = asyncio.create_task(self._application(self._scope, self._incoming.get, self._outgoing.put))
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
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            cls.admin_app = importlib.import_module("app")
        cls.chat_ws = importlib.import_module("chat_ws")
        cls.teams = importlib.import_module("teams")
        previous_store = cls.admin_app.adminstore.STORE_PATH
        previous_origins = cls.chat_ws.ALLOWED_ORIGINS
        cls.admin_app.adminstore.STORE_PATH = cls.root / "admin.json"
        cls.chat_ws.ALLOWED_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.adminstore, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.chat_ws, "ALLOWED_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.adminstore.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.adminstore.set_password("correct horse battery staple")
        store = self.admin_app.adminstore.get()
        self.token = self.admin_app.auth.issue_session(store["session_secret"])

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v2", "headers": []}

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
                protocols=["shimpz.chat.v2", "shimpz.chat.v1"],
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
                    "assistant_ids": ["shimpz-assistant", "shimpz-assistant"],
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
            with mock.patch.object(self.chat_ws.localchat, "turn") as turn:
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
            store = self.admin_app.adminstore.get()
            store["session_secret"] = self.admin_app.auth.new_secret()
            self.admin_app.adminstore._write(store)
            with mock.patch.object(self.chat_ws.localchat, "turn") as turn:
                await websocket.send_json({"type": "chat", "message": "must not run", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 4401, "reason": ""},
                )
                await websocket.finish()
                turn.assert_not_called()

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
                "x" * (self.chat_ws.MAX_FRAME_BYTES + 1),
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

    def test_real_uvicorn_negotiates_v2_and_delivers_one_public_terminal(self) -> None:
        async def scenario() -> None:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(128)
            port = listener.getsockname()[1]
            server = uvicorn.Server(
                uvicorn.Config(
                    self.admin_app.app,
                    host="127.0.0.1",
                    port=port,
                    lifespan="off",
                    log_level="critical",
                )
            )
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            deadline = asyncio.get_running_loop().time() + 2
            while not server.started:
                if server_task.done():
                    await server_task
                if asyncio.get_running_loop().time() >= deadline:
                    self.fail("Uvicorn did not start")
                await asyncio.sleep(0.01)

            uri = f"ws://127.0.0.1:{port}/api/teams/team_1/chat/ws"
            headers = {"Cookie": f"shimpz_admin={self.token}"}
            response = self.teams.DriverResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "hello from the Team"},
            )
            try:
                with self.assertRaises(InvalidStatus):
                    await websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        additional_headers=headers,
                    )
                with mock.patch.object(self.chat_ws.localchat, "turn", return_value=response):
                    async with websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        subprotocols=["shimpz.chat.v2"],
                        additional_headers=headers,
                    ) as websocket:
                        self.assertEqual(websocket.subprotocol, "shimpz.chat.v2")
                        await websocket.send('{"type":"chat","message":"hello","files":[],"assistant_ids":[]}')
                        self.assertEqual(
                            json.loads(await asyncio.wait_for(websocket.recv(), timeout=1)),
                            {
                                "type": "done",
                                "team_id": "team_1",
                                "team_name": "Marketing",
                                "reply": "hello from the Team",
                            },
                        )
                        with self.assertRaises(TimeoutError):
                            await asyncio.wait_for(websocket.recv(), timeout=0.05)
            finally:
                server.should_exit = True
                await asyncio.wait_for(server_task, timeout=3)
                listener.close()

        asyncio.run(scenario())

    def test_one_active_turn_and_stop_emit_exactly_one_terminal(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload):
                started.set()
                release.wait(timeout=2)
                return self.teams.DriverResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "late reply"},
                )

            stopped = self.teams.DriverResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", side_effect=turn) as turn_mock,
                mock.patch.object(self.chat_ws.localchat, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "first",
                        "files": [],
                        "assistant_ids": ["shimpz-assistant"],
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
                await websocket.disconnect()
                self.assertEqual(turn_mock.call_count, 1)
                turn_mock.assert_called_once_with(
                    "team_1",
                    {"message": "first", "files": [], "assistant_ids": ["shimpz-assistant"]},
                )
                self.assertEqual(stop_mock.call_count, 1)

        asyncio.run(scenario())

    def test_disconnect_stops_a_running_turn_once(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload):
                started.set()
                release.wait(timeout=2)
                return self.teams.DriverResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "discard me"},
                )

            stopped = self.teams.DriverResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", side_effect=turn),
                mock.patch.object(self.chat_ws.localchat, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "running", "files": [], "assistant_ids": []})
                await _wait_for_thread(started)
                await websocket.disconnect()
                self.assertEqual(stop_mock.call_count, 1)
                release.set()

        asyncio.run(scenario())

    def test_public_terminal_relays_only_the_closed_sanitized_error_document(self) -> None:
        async def response_for(driver_response) -> dict:
            with mock.patch.object(self.chat_ws.localchat, "turn", return_value=driver_response):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "chat", "message": "hello", "files": [], "assistant_ids": []})
                event = await websocket.next_json()
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                await websocket.disconnect()
                return event

        async def scenario() -> None:
            concrete_error = await response_for(
                self.teams.DriverResponse(
                    409,
                    {"code": "team-has-no-active-assistants"},
                )
            )
            self.assertEqual(
                concrete_error,
                {
                    "type": "error",
                    "status": 409,
                    "detail": (
                        "team-has-no-active-assistants: install and start at least one Assistant before chatting"
                    ),
                },
            )

            sensitive_marker = "sk-private-must-never-cross-the-websocket"
            upstream_error = await response_for(
                self.teams.DriverResponse(
                    502,
                    {"code": "brain-runtime-failed", "debug": sensitive_marker},
                )
            )
            self.assertEqual(
                upstream_error,
                {"type": "error", "status": 502, "detail": "local chat request failed"},
            )
            self.assertNotIn(sensitive_marker, json.dumps(upstream_error))

            unknown_code = await response_for(self.teams.DriverResponse(409, {"code": "private-controller-diagnostic"}))
            self.assertEqual(
                unknown_code,
                {"type": "error", "status": 409, "detail": "chat turn could not start"},
            )

            augmented_success = await response_for(
                self.teams.DriverResponse(
                    200,
                    {
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "hello",
                        "debug": sensitive_marker,
                    },
                )
            )
            self.assertEqual(
                augmented_success,
                {"type": "error", "status": 502, "detail": "local chat returned an invalid response"},
            )
            self.assertNotIn(sensitive_marker, json.dumps(augmented_success))

        asyncio.run(scenario())

    def test_worker_queue_rejects_instead_of_growing(self) -> None:
        executor = self.chat_ws.BoundedExecutor(workers=1, outstanding=1, name="chat-test")
        release = threading.Event()
        future = executor.submit(release.wait)
        try:
            with self.assertRaises(self.chat_ws.ExecutorSaturatedError):
                executor.submit(lambda: None)
        finally:
            release.set()
            future.result(timeout=1)
            executor.shutdown()


if __name__ == "__main__":
    unittest.main()
