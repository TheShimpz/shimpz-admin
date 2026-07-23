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

import chat_ws_fixtures

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

TURN_ID = chat_ws_fixtures.TURN_ID
CHALLENGE_ID = chat_ws_fixtures.CHALLENGE_ID
_account_challenge = chat_ws_fixtures.account_challenge
_account_requirements = chat_ws_fixtures.account_requirements
_approval_challenge = chat_ws_fixtures.approval_challenge
_approval_requirements = chat_ws_fixtures.approval_requirements
_challenge = chat_ws_fixtures.challenge
_input_challenge = chat_ws_fixtures.input_challenge
_inventory = chat_ws_fixtures.inventory
_requirements = chat_ws_fixtures.requirements


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
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v3", "headers": []}

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
                protocols=["shimpz.chat.v3", "shimpz.chat.v2"],
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
            with mock.patch.object(self.chat_ws.localchat, "turn") as turn:
                for frame in invalid_frames:
                    await websocket.send_json(frame)
                    self.assertEqual((await websocket.next_json())["status"], 400)
                turn.assert_not_called()
            await websocket.disconnect()

        asyncio.run(scenario())

    def test_typed_input_frames_resume_all_six_request_types(self) -> None:
        async def scenario() -> None:
            cases = (
                ("str", [], "Ada"),
                ("int", [], 3),
                ("float", [], 3.5),
                ("bool", [], True),
                ("choice", ["one", "two"], "two"),
                ("choices", ["one", "two"], ["one", "two"]),
            )
            completed = self.chat_ws.localchat.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Answered."},
            )
            for request_type, options, answer in cases:
                with (
                    self.subTest(request_type=request_type),
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "turn",
                        return_value=_input_challenge(request_type, options),
                    ),
                    mock.patch.object(self.chat_ws.localchat, "submit_input", return_value=completed) as submit,
                ):
                    websocket = _Socket(self.admin_app.app, token=self.token)
                    self.assertTrue(self._accepted(await websocket.start()))
                    await websocket.send_json(
                        {"type": "chat", "message": "ask", "files": [], "assistant_ids": ["weather-guide"]}
                    )
                    self.assertEqual(
                        await websocket.next_json(),
                        {
                            "type": "input-required",
                            "turn_id": TURN_ID,
                            "challenge_id": CHALLENGE_ID,
                            "request": {
                                "type": request_type,
                                "title": "Choose",
                                "summary": "Provide one value.",
                                "docs": None,
                                "options": options,
                            },
                        },
                    )
                    await websocket.send_json({"type": "input-submit", "challenge_id": CHALLENGE_ID, "answer": answer})
                    self.assertEqual((await websocket.next_json())["type"], "done")
                    submit.assert_called_once_with(
                        "team_1",
                        {"challenge_id": CHALLENGE_ID, "answer": answer},
                    )
                    await websocket.disconnect()

        asyncio.run(scenario())

    def test_chat_pauses_on_account_before_secret_or_approval_submission(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", return_value=_account_challenge()),
                mock.patch.object(self.chat_ws.localchat, "submit_secrets") as submit_secret,
                mock.patch.object(self.chat_ws.localchat, "submit_approval") as submit_approval,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "publish",
                        "files": [],
                        "assistant_ids": ["social-publisher"],
                    }
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "accounts-required",
                        "challenge_id": CHALLENGE_ID,
                        "expires_in": 300,
                        "requirements": _account_requirements(),
                    },
                )
                await websocket.send_json(
                    {
                        "type": "secret-submit",
                        "challenge_id": CHALLENGE_ID,
                        "values": [
                            {
                                "assistant_id": "social-publisher",
                                "secret_id": "x-api-key",
                                "value": "not-an-oauth-substitute",
                            }
                        ],
                    }
                )
                self.assertEqual((await websocket.next_json())["status"], 409)
                submit_secret.assert_not_called()
                submit_approval.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_secret_submission_enforces_exact_shape_count_and_utf8_value_cap(self) -> None:
        async def scenario() -> None:
            websocket = _Socket(self.admin_app.app, token=self.token)
            self.assertTrue(self._accepted(await websocket.start()))
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", return_value=_challenge()),
                mock.patch.object(self.chat_ws.localchat, "submit_secrets") as submit,
            ):
                await websocket.send_json(
                    {"type": "chat", "message": "weather", "files": [], "assistant_ids": ["weather-guide"]}
                )
                self.assertEqual((await websocket.next_json())["type"], "secrets-required")
                invalid_values = (
                    [
                        {
                            "assistant_id": "weather-guide",
                            "secret_id": f"secret-{index}",
                            "value": f"value-{index}",
                        }
                        for index in range(65)
                    ],
                    [
                        {
                            "assistant_id": "weather-guide",
                            "secret_id": "weather-api-token",
                            "value": "x" * (16 * 1024 + 1),
                        }
                    ],
                    [
                        {
                            "assistant_id": "weather-guide",
                            "secret_id": "weather-api-token",
                            "value": "first",
                        },
                        {
                            "assistant_id": "weather-guide",
                            "secret_id": "weather-api-token",
                            "value": "second",
                        },
                    ],
                )
                for values in invalid_values:
                    await websocket.send_json({"type": "secret-submit", "challenge_id": CHALLENGE_ID, "values": values})
                    self.assertEqual(
                        await websocket.next_json(),
                        {"type": "error", "status": 400, "detail": "invalid Assistant secret submission"},
                    )
                await websocket.send_json(
                    {
                        "type": "secret-submit",
                        "challenge_id": CHALLENGE_ID,
                        "values": [],
                        "extra": True,
                    }
                )
                self.assertEqual((await websocket.next_json())["status"], 400)
                submit.assert_not_called()
            await websocket.disconnect()

        self.assertEqual(self.chat_ws.MAX_FRAME_BYTES, 512 * 1024)
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

    def test_one_active_turn_and_stop_emit_exactly_one_terminal(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def turn(_team_id, _payload):
                started.set()
                release.wait(timeout=2)
                return self.chat_ws.localchat.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "late reply"},
                )

            stopped = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "stopped": True})
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
                await websocket.disconnect()
                self.assertEqual(turn_mock.call_count, 1)
                turn_mock.assert_called_once_with(
                    "team_1",
                    {"message": "first", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
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
                return self.chat_ws.localchat.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "discard me"},
                )

            stopped = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "stopped": True})
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

    def test_pending_secret_challenge_is_cancelled_on_disconnect_and_not_resynced(self) -> None:
        async def scenario() -> None:
            none_pending = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "status": "none"})
            stopped = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", return_value=_challenge()),
                mock.patch.object(self.chat_ws.localchat, "stop", return_value=stopped) as stop_mock,
            ):
                first = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await first.start()))
                await first.send_json(
                    {"type": "chat", "message": "weather", "files": [], "assistant_ids": ["weather-guide"]}
                )
                challenge_event = await first.next_json()
                self.assertEqual(
                    challenge_event,
                    {
                        "type": "secrets-required",
                        "turn_id": TURN_ID,
                        "challenge_id": CHALLENGE_ID,
                        "requirements": _requirements(),
                    },
                )
                await first.disconnect()
                stop_mock.assert_called_once_with("team_1")

                with (
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "secret_inventory",
                        return_value=_inventory(),
                    ) as inventory,
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "pending_accounts",
                        return_value=none_pending,
                    ),
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "pending_secrets",
                        return_value=none_pending,
                    ) as pending_mock,
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "pending_approval",
                        return_value=none_pending,
                    ),
                    mock.patch.object(
                        self.chat_ws.localchat,
                        "pending_input",
                        return_value=none_pending,
                    ),
                ):
                    second = _Socket(self.admin_app.app, token=self.token)
                    self.assertTrue(self._accepted(await second.start()))
                    await second.send_json({"type": "sync"})
                    self.assertEqual(
                        await second.next_json(),
                        {
                            "type": "secret-inventory",
                            "team_id": "team_1",
                            "assistants": _inventory().body["assistants"],
                        },
                    )
                    inventory.assert_called_once_with("team_1")
                    pending_mock.assert_called_once_with("team_1")
                    with self.assertRaises(TimeoutError):
                        await second.next_message(wait_seconds=0.05)
                    await second.disconnect()

        asyncio.run(scenario())

    def test_account_sync_resumes_exact_challenge_before_secret_or_approval(self) -> None:
        async def scenario() -> None:
            pending_account = _account_challenge(status=200)
            next_secret = _challenge()
            with (
                mock.patch.object(self.chat_ws.localchat, "secret_inventory", return_value=_inventory()),
                mock.patch.object(
                    self.chat_ws.localchat,
                    "pending_accounts",
                    return_value=pending_account,
                ),
                mock.patch.object(
                    self.chat_ws.localchat,
                    "resume_accounts",
                    return_value=next_secret,
                ) as resume,
                mock.patch.object(self.chat_ws.localchat, "pending_secrets") as pending_secret,
                mock.patch.object(self.chat_ws.localchat, "pending_approval") as pending_approval,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "secret-inventory")
                self.assertEqual((await websocket.next_json())["type"], "secrets-required")
                resume.assert_called_once_with("team_1", CHALLENGE_ID)
                pending_secret.assert_not_called()
                pending_approval.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_account_sync_rejects_augmented_pending_state_without_resuming(self) -> None:
        async def scenario() -> None:
            sensitive_marker = "must-not-cross"
            augmented = self.teams.DriverResponse(
                200,
                {**dict(_account_challenge(status=200).body), "access_token": sensitive_marker},
            )
            with (
                mock.patch.object(self.chat_ws.localchat, "secret_inventory", return_value=_inventory()),
                mock.patch.object(self.chat_ws.localchat, "pending_accounts", return_value=augmented),
                mock.patch.object(self.chat_ws.localchat, "resume_accounts") as resume,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "secret-inventory")
                error = await websocket.next_json()
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["status"], 502)
                self.assertNotIn(sensitive_marker, json.dumps(error))
                resume.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_account_sync_delivers_done_only_after_explicit_resume(self) -> None:
        async def scenario() -> None:
            completed = self.chat_ws.localchat.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Published."},
            )
            none_pending = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "status": "none"})
            with (
                mock.patch.object(self.chat_ws.localchat, "secret_inventory", return_value=_inventory()),
                mock.patch.object(
                    self.chat_ws.localchat,
                    "pending_accounts",
                    return_value=_account_challenge(status=200),
                ),
                mock.patch.object(
                    self.chat_ws.localchat,
                    "resume_accounts",
                    return_value=completed,
                ) as resume,
                mock.patch.object(self.chat_ws.localchat, "pending_secrets", return_value=none_pending),
                mock.patch.object(self.chat_ws.localchat, "pending_approval", return_value=none_pending),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "secret-inventory")
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Published.",
                    },
                )
                resume.assert_called_once_with("team_1", CHALLENGE_ID)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_account_sync_rejects_a_next_gate_from_another_turn(self) -> None:
        async def scenario() -> None:
            next_secret = self.chat_ws.localchat.PublicResponse(
                428,
                {**dict(_challenge().body), "turn_id": "c" * 32},
            )
            with (
                mock.patch.object(self.chat_ws.localchat, "secret_inventory", return_value=_inventory()),
                mock.patch.object(
                    self.chat_ws.localchat,
                    "pending_accounts",
                    return_value=_account_challenge(status=200),
                ),
                mock.patch.object(self.chat_ws.localchat, "resume_accounts", return_value=next_secret),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "secret-inventory")
                error = await websocket.next_json()
                self.assertEqual(error["type"], "error")
                self.assertEqual(error["status"], 502)
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_explicit_approval_resumes_only_the_exact_pending_challenge(self) -> None:
        async def scenario() -> None:
            completed = self.chat_ws.localchat.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Both posts were published."},
            )
            with (
                mock.patch.object(self.chat_ws.localchat, "turn", return_value=_approval_challenge()),
                mock.patch.object(self.chat_ws.localchat, "submit_approval", return_value=completed) as submit,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "publish both", "files": [], "assistant_ids": ["social-publisher"]}
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "approval-required",
                        "turn_id": TURN_ID,
                        "challenge_id": CHALLENGE_ID,
                        "requirements": _approval_requirements(),
                    },
                )
                invalid = (
                    {"type": "approval-submit", "challenge_id": CHALLENGE_ID, "approved": False},
                    {"type": "approval-submit", "challenge_id": "c" * 32, "approved": True},
                    {"type": "approval-submit", "challenge_id": CHALLENGE_ID, "approved": True, "input": {}},
                )
                for frame in invalid:
                    await websocket.send_json(frame)
                    self.assertIn((await websocket.next_json())["status"], {400, 409})
                submit.assert_not_called()

                await websocket.send_json({"type": "approval-submit", "challenge_id": CHALLENGE_ID, "approved": True})
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Both posts were published.",
                    },
                )
                submit.assert_called_once_with(
                    "team_1",
                    {"challenge_id": CHALLENGE_ID, "approved": True},
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_one_secret_submit_resumes_the_turn_without_echoing_its_value(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()
            submitted_value = "test-private-must-never-cross-the-websocket"
            completed = self.chat_ws.localchat.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Lisbon is sunny."},
            )

            def submit(_team_id, _payload):
                started.set()
                release.wait(timeout=2)
                return completed

            with (
                mock.patch.object(self.chat_ws.localchat, "turn", return_value=_challenge()),
                mock.patch.object(self.chat_ws.localchat, "submit_secrets", side_effect=submit) as submit_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "weather", "files": [], "assistant_ids": ["weather-guide"]}
                )
                self.assertEqual((await websocket.next_json())["type"], "secrets-required")
                frame = {
                    "type": "secret-submit",
                    "challenge_id": CHALLENGE_ID,
                    "values": [
                        {
                            "assistant_id": "weather-guide",
                            "secret_id": "weather-api-token",
                            "value": submitted_value,
                        }
                    ],
                }
                await websocket.send_json(frame)
                await _wait_for_thread(started)
                await websocket.send_json(frame)
                self.assertEqual(
                    await websocket.next_json(),
                    {"type": "error", "status": 409, "detail": "a chat operation is already active"},
                )
                release.set()
                terminal = await websocket.next_json()
                self.assertEqual(
                    terminal,
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Lisbon is sunny.",
                    },
                )
                self.assertNotIn(submitted_value, json.dumps(terminal))
                submit_mock.assert_called_once_with(
                    "team_1",
                    {
                        "challenge_id": CHALLENGE_ID,
                        "values": [
                            {
                                "assistant_id": "weather-guide",
                                "secret_id": "weather-api-token",
                                "value": submitted_value,
                            }
                        ],
                    },
                )
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_stop_cancels_a_pending_secret_challenge_through_localchat(self) -> None:
        async def scenario() -> None:
            stopped = self.chat_ws.localchat.PublicResponse(200, {"team_id": "team_1", "stopped": True})
            completed = self.chat_ws.localchat.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Fresh turn."},
            )
            with (
                mock.patch.object(
                    self.chat_ws.localchat,
                    "turn",
                    side_effect=(_challenge(), completed),
                ) as turn_mock,
                mock.patch.object(self.chat_ws.localchat, "stop", return_value=stopped) as stop_mock,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {"type": "chat", "message": "weather", "files": [], "assistant_ids": ["weather-guide"]}
                )
                self.assertEqual((await websocket.next_json())["type"], "secrets-required")
                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                stop_mock.assert_called_once_with("team_1")
                await websocket.send_json(
                    {"type": "chat", "message": "hello again", "files": [], "assistant_ids": ["weather-guide"]}
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "done",
                        "team_id": "team_1",
                        "team_name": "Marketing",
                        "reply": "Fresh turn.",
                    },
                )
                self.assertEqual(turn_mock.call_count, 2)
                await websocket.disconnect()

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
                self.chat_ws.localchat.PublicResponse(
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
                {"type": "error", "status": 502, "detail": "local chat returned an invalid response"},
            )
            self.assertNotIn(sensitive_marker, json.dumps(upstream_error))

            unknown_code = await response_for(
                self.chat_ws.localchat.PublicResponse(409, {"code": "private-controller-diagnostic"})
            )
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


if __name__ == "__main__":
    unittest.main()
