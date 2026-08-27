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
from mfa_helper import configure_supervisor

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


_Socket = chat_socket_fixtures.Socket
_wait_for_thread = chat_socket_fixtures.wait_for_thread


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
        secret = configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        self.token = self.admin_app.auth.issue_session(secret, "totp")
        empty = self.team.TeamResponse(200, {"team_id": "team_1", "status": "none"})
        pending_human = mock.patch.object(
            self.chat_socket.local,
            "pending_human",
            return_value=empty,
        )
        pending_human.start()
        self.addCleanup(pending_human.stop)

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v7", "headers": []}

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

    def test_disconnect_does_not_cancel_an_oauth_resumed_turn(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()
            finished = threading.Event()

            def resume_integrations(_team_id, _challenge_id, _progress):
                started.set()
                release.wait(timeout=2)
                finished.set()
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "Team-authoritative."},
                )

            with (
                mock.patch.object(
                    self.chat_socket.local,
                    "pending_integrations",
                    return_value=_integration_challenge(status=200),
                ),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_integrations",
                    side_effect=resume_integrations,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                await _wait_for_thread(started)
                await websocket.disconnect()
                stop.assert_not_called()
                self.assertFalse(finished.is_set())
                release.set()
                await _wait_for_thread(finished)
                stop.assert_not_called()

        asyncio.run(scenario())

    def test_stop_during_sync_emits_one_terminal_without_cancelling_team(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()
            finished = threading.Event()
            pending = _integration_challenge(status=200)
            resume_calls = 0

            def resume_integrations(_team_id, _challenge_id, _progress):
                nonlocal resume_calls
                resume_calls += 1
                if resume_calls == 1:
                    return pending
                started.set()
                release.wait(timeout=2)
                finished.set()
                return self.chat_socket.local.PublicResponse(
                    200,
                    {"team_id": "team_1", "team_name": "Marketing", "reply": "late completion"},
                )

            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=pending),
                mock.patch.object(
                    self.chat_socket.local,
                    "resume_integrations",
                    side_effect=resume_integrations,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["type"], "integrations-required")
                await websocket.send_json({"type": "sync"})
                await _wait_for_thread(started)
                await websocket.send_json({"type": "stop"})
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "error",
                        "status": 409,
                        "detail": "a chat continuation is already active",
                    },
                )
                self.assertEqual(
                    await websocket.next_message(),
                    {"type": "websocket.close", "code": 1008, "reason": ""},
                )
                await websocket.finish()
                stop.assert_not_called()
                release.set()
                await _wait_for_thread(finished)
                with self.assertRaises(TimeoutError):
                    await websocket.next_message(wait_seconds=0.05)
                stop.assert_not_called()

        asyncio.run(scenario())

    def test_claimed_sync_terminal_suppresses_a_late_mismatch_or_gate(self) -> None:
        async def scenario() -> None:
            pending = _integration_challenge(status=200)
            mismatch = self.chat_socket.local.PublicResponse(
                428,
                {**pending.body, "turn_id": "c" * 32},
            )
            websocket = mock.AsyncMock()
            connection = self.chat_socket._Connection(sync_terminal_sent=True)

            await self.chat_socket._deliver_integration_sync(
                websocket,
                connection,
                "team_1",
                pending,
                mismatch,
            )
            await self.chat_socket._deliver_integration_sync(
                websocket,
                connection,
                "team_1",
                pending,
                pending,
            )

            websocket.send_json.assert_not_awaited()

        asyncio.run(scenario())

    def test_sync_delivery_exception_fails_closed_with_one_terminal(self) -> None:
        async def scenario() -> None:
            empty = self.team.TeamResponse(200, {"team_id": "team_1", "status": "none"})
            with (
                mock.patch.object(self.chat_socket.local, "pending_integrations", return_value=empty),
                mock.patch.object(
                    self.chat_socket,
                    "_deliver_human_sync",
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
