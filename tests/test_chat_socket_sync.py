"""Focused security and lifecycle contracts for the local Admin chat WebSocket."""

from __future__ import annotations

import asyncio
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

CHALLENGE_ID = chat_socket_fixtures.CHALLENGE_ID
_integration_challenge = chat_socket_fixtures.integration_challenge

_MEASURED_PROGRESS = (
    {"origin": "admin", "phase": "admin-preparation", "state": "started"},
    {
        "origin": "admin",
        "phase": "admin-preparation",
        "state": "finished",
        "elapsed_ms": 4,
    },
    {"origin": "admin", "phase": "reply-validation", "state": "started"},
    {
        "origin": "admin",
        "phase": "reply-validation",
        "state": "finished",
        "elapsed_ms": 1,
    },
)


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
        offered = ["shimpz.chat.v3"] if protocols is None else protocols
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


class ChatWebSocketSyncTests(unittest.TestCase):
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
        self.admin_app.state.set_password("correct horse battery staple")
        store = self.admin_app.state.get()
        self.token = self.admin_app.auth.issue_session(store["session_secret"])

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v3", "headers": []}

    def test_integration_sync_rejects_augmented_pending_state_without_resuming(self) -> None:
        async def scenario() -> None:
            sensitive_marker = "must-not-cross"
            augmented = self.team.TeamResponse(
                200,
                {**dict(_integration_challenge(status=200).body), "access_token": sensitive_marker},
            )
            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=augmented),
                mock.patch.object(self.chat_socket.local, "resume_integrations") as resume,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                error = await websocket.next_json()
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["status"], 502)
                self.assertNotIn(sensitive_marker, json.dumps(error))
                resume.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_empty_integration_sync_returns_one_exact_nonterminal_event(self) -> None:
        async def scenario() -> None:
            empty = self.team.TeamResponse(200, {"team_id": "team_1", "status": "none"})
            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=empty),
                mock.patch.object(self.chat_socket.local, "resume_integrations") as resume,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual(await websocket.next_json(), {"type": "sync-empty"})
                resume.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_empty_sync_clears_an_expired_challenge_before_the_next_turn(self) -> None:
        async def scenario() -> None:
            pending = _integration_challenge(status=200)
            empty = self.team.TeamResponse(200, {"team_id": "team_1", "status": "none"})
            completed = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Fresh turn."},
            )
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "pending_integrations",
                    side_effect=[pending, empty],
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_integrations",
                    return_value=pending,
                ),
                mock.patch.object(self.chat_socket.local, "turn", return_value=completed) as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                await websocket.send_json({"type": "sync"})
                self.assertEqual(await websocket.next_json(), {"type": "sync-empty"})
                await websocket.send_json({"type": "chat", "message": "Retry", "files": [], "assistant_ids": []})
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Fresh turn.",
                    },
                )
                turn.assert_called_once()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_integration_sync_delivers_done_only_after_explicit_resume(self) -> None:
        async def scenario() -> None:
            completed = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Published."},
            )
            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "pending_integrations",
                    return_value=_integration_challenge(status=200),
                ),
                mock.patch.object(self.chat_socket.local, "resume_integrations") as resume,
            ):

                def resume_integrations(_team_id, _challenge_id, progress):
                    for event in _MEASURED_PROGRESS:
                        progress(dict(event))
                    return completed

                resume.side_effect = resume_integrations
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual(
                    [await websocket.next_json() for _index in range(4)],
                    [
                        {"type": "progress", "seq": sequence, **event}
                        for sequence, event in enumerate(_MEASURED_PROGRESS, start=1)
                    ],
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Published.",
                    },
                )
                resume.assert_called_once_with("team_1", CHALLENGE_ID, mock.ANY)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_sync_delivery_exception_fails_closed_with_one_terminal(self) -> None:
        async def scenario() -> None:
            empty = self.team.TeamResponse(200, {"team_id": "team_1", "status": "none"})
            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=empty),
                mock.patch.object(
                    self.chat_socket,
                    "_deliver_integration_sync",
                    side_effect=RuntimeError("must not escape"),
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "error", "status": 502, "detail": "local chat request failed"},
                )
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_public_terminal_relays_only_the_closed_sanitized_error_document(self) -> None:
        async def response_for(team_response) -> dict:
            with mock.patch.object(self.chat_socket.local, "turn", return_value=team_response):
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
                self.chat_socket.local.PublicResponse(
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
                self.team.TeamResponse(
                    502,
                    {"code": "brain-runtime-failed", "debug": sensitive_marker},
                )
            )
            self.assertEqual(
                upstream_error,
                {"type": "error", "status": 502, "detail": "local chat returned an invalid response"},
            )
            self.assertNotIn(sensitive_marker, json.dumps(upstream_error))

            unknown_code = await response_for(
                self.chat_socket.local.PublicResponse(409, {"code": "private-controller-diagnostic"})
            )
            self.assertEqual(
                unknown_code,
                {"type": "error", "status": 409, "detail": "chat turn could not start"},
            )

            augmented_success = await response_for(
                self.team.TeamResponse(
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


if __name__ == "__main__":
    unittest.main()
