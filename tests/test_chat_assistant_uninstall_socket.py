"""Focused WebSocket projection for conversational Assistant uninstall."""

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

_Socket = chat_socket_fixtures.Socket


class ChatAssistantUninstallSocketTests(unittest.TestCase):
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
        previous_store = cls.admin_app.state.STORE_PATH
        previous_history_store = cls.admin_app.chat_history.STORE_PATH
        previous_origins = cls.chat_socket.STATIC_ORIGINS
        cls.admin_app.state.STORE_PATH = cls.root / "admin.json"
        cls.admin_app.chat_history.STORE_PATH = cls.root / "chat-history.sqlite3"
        cls.chat_socket.STATIC_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.admin_app.chat_history, "STORE_PATH", previous_history_store)
        cls.addClassCleanup(setattr, cls.chat_socket, "STATIC_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.chat_history.STORE_PATH.unlink(missing_ok=True)
        secret = configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        self.token = self.admin_app.auth.issue_session(secret, "totp")

    def _uninstall_candidate(self):
        return self.chat_socket.lifecycle.assistant_proposal.UninstallCandidate(
            self.chat_socket.lifecycle.assistant_proposal.Capability(
                "shimpz-cloudflare",
                "Shimpz Cloudflare",
                "Manage Cloudflare zones and DNS records.",
                ("list-zones",),
            ),
            "0.4.4",
        )

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {
            "type": "websocket.accept",
            "subprotocol": "shimpz.chat.v7",
            "headers": [],
        }

    def test_explicit_uninstall_uses_one_socket_scoped_proposal_and_team_result(self) -> None:
        async def scenario() -> None:
            release_discovery = threading.Event()

            def discover(*_args):
                release_discovery.wait(timeout=2)
                return self._uninstall_candidate()

            result = self.chat_socket.lifecycle.assistant_uninstall.UninstallResult(200, True)
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    side_effect=discover,
                ),
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "uninstall",
                    return_value=result,
                ) as uninstall,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
                await asyncio.sleep(0.3)
                turn.assert_not_called()
                release_discovery.set()
                proposed = await websocket.next_json()
                self.assertEqual(proposed["type"], "assistant-uninstall")
                self.assertEqual(proposed["state"], "proposed")
                self.assertEqual(proposed["expires_in"], 120)
                self.assertEqual(
                    proposed["assistant"],
                    {
                        "id": "shimpz-cloudflare",
                        "name": "Shimpz Cloudflare",
                        "summary": "Manage Cloudflare zones and DNS records.",
                        "version": "0.4.4",
                    },
                )
                self.assertNotIn("source_digest", json.dumps(proposed))

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Pode desinstalar!",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-uninstall",
                        "state": "uninstalling",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                    },
                )
                self.assertEqual(
                    await websocket.next_json(),
                    {
                        "type": "assistant-uninstall",
                        "state": "uninstalled",
                        "proposal_id": proposed["proposal_id"],
                        "assistant_id": "shimpz-cloudflare",
                        "team_id": "team_1",
                        "uninstalled": True,
                    },
                )
                proposal = uninstall.call_args.args[0]
                self.assertEqual(proposal.assistant_version, "0.4.4")
                self.assertEqual(
                    proposal.language_exemplar,
                    "Desinstala o Cloudflare",
                )
                turn.assert_not_called()
                await websocket.disconnect()

            entries = self.admin_app.chat_history.page("team_1")["entries"]
            self.assertEqual(
                [(entry["kind"], entry.get("text")) for entry in entries],
                [
                    ("message", "Desinstala o Cloudflare"),
                    ("assistant-uninstall", None),
                ],
            )

        asyncio.run(scenario())

    def test_targeted_uninstall_after_ambiguous_retire_creates_a_fresh_proposal(self) -> None:
        async def scenario() -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    return_value=self._uninstall_candidate(),
                ),
                mock.patch.object(self.chat_socket.lifecycle.assistant_uninstall, "uninstall") as uninstall,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
                proposed = await websocket.next_json()
                self.assertEqual((proposed["type"], proposed["state"]), ("assistant-uninstall", "proposed"))

                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                reproposed = await websocket.next_json()
                self.assertEqual((reproposed["type"], reproposed["state"]), ("assistant-uninstall", "proposed"))
                self.assertNotEqual(reproposed["proposal_id"], proposed["proposal_id"])
                uninstall.assert_not_called()
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_discovery_failure_and_no_match_never_fall_through_to_brain(self) -> None:
        async def scenario(result, expected) -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    side_effect=result if isinstance(result, Exception) else None,
                    return_value=None if isinstance(result, Exception) else result,
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                event = await websocket.next_json()
                self.assertEqual((event["type"], event.get("state"), event.get("status")), expected)
                turn.assert_not_called()
                await websocket.disconnect()

        asyncio.run(scenario(None, ("assistant-uninstall", "target-required", None)))
        asyncio.run(scenario(ValueError("invalid inventory"), ("error", None, 503)))

    def test_discovery_saturation_is_explicit_and_never_calls_brain(self) -> None:
        async def scenario(failure: Exception, status: int) -> None:
            with (
                mock.patch.object(self.chat_socket.local, "turn") as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle,
                    "submit_discovery",
                    side_effect=failure,
                ),
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                event = await websocket.next_json()
                self.assertEqual((event["type"], event["status"]), ("error", status))
                turn.assert_not_called()
                await websocket.send_json({"type": "stop"})
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                guidance = await websocket.next_json()
                self.assertEqual(
                    (guidance["type"], guidance["state"]),
                    ("assistant-uninstall", "target-required"),
                )
                await websocket.disconnect()

        asyncio.run(scenario(self.chat_socket.ExecutorSaturatedError(), 429))
        asyncio.run(scenario(ValueError("invalid inventory authority"), 503))

    def test_stop_during_discovery_never_dispatches_a_team_chat_stop(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def discover(*_args):
                started.set()
                release.wait(timeout=2)
                return self._uninstall_candidate()

            with (
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    side_effect=discover,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "desinstale o cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                await asyncio.to_thread(started.wait, 1)
                await websocket.send_json({"type": "stop"})
                self.assertEqual(await websocket.next_json(), {"type": "stopped"})
                stop.assert_not_called()
                turn.assert_not_called()
                release.set()
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_discovery_excludes_concurrent_chat_and_sync(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def discover(*_args):
                started.set()
                release.wait(timeout=2)
                return self._uninstall_candidate()

            with mock.patch.object(
                self.chat_socket.lifecycle.assistant_uninstall,
                "discover",
                side_effect=discover,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "continue",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertEqual((await websocket.next_json())["status"], 409)
                await websocket.send_json({"type": "sync"})
                self.assertEqual((await websocket.next_json())["status"], 409)
                release.set()
                self.assertEqual((await websocket.next_json())["state"], "proposed")
                await websocket.disconnect()

        asyncio.run(scenario())

    def test_disconnect_during_discovery_never_dispatches_a_team_chat_stop(self) -> None:
        async def scenario() -> None:
            started = threading.Event()
            release = threading.Event()

            def discover(*_args):
                started.set()
                release.wait(timeout=2)
                return self._uninstall_candidate()

            with (
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    side_effect=discover,
                ),
                mock.patch.object(self.chat_socket.local, "stop") as stop,
                mock.patch.object(self.chat_socket.local, "turn") as turn,
            ):
                websocket = _Socket(self.admin_app.app, token=self.token)
                self.assertTrue(self._accepted(await websocket.start()))
                await websocket.send_json(
                    {
                        "type": "chat",
                        "message": "Desinstala o Cloudflare",
                        "files": [],
                        "assistant_ids": [],
                    }
                )
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                try:
                    await websocket.disconnect()
                finally:
                    release.set()
                stop.assert_not_called()
                turn.assert_not_called()

        asyncio.run(scenario())

    def test_uninstall_delivery_edges_fail_closed_and_detach_the_turn(self) -> None:
        async def scenario() -> None:
            delivery = self.chat_socket.uninstall_delivery
            self.assertFalse(delivery._inactive(delivery.Connection(), delivery.Turn(None, "test")))
            self.assertTrue(delivery._inactive(delivery.Connection(closed=True), delivery.Turn(None, "test")))
            self.assertTrue(delivery._inactive(delivery.Connection(), delivery.Turn(None, "test", stop_requested=True)))
            self.assertTrue(delivery._inactive(delivery.Connection(), delivery.Turn(None, "test", terminal_sent=True)))

            missing = await delivery._candidate_event(
                delivery.Connection(),
                delivery.Turn(None, "assistant-uninstall-discovery"),
                "team_1",
            )
            self.assertEqual(missing["status"], 503)

            invalid_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            invalid_future.set_result(object())
            invalid = await delivery._candidate_event(
                delivery.Connection(),
                delivery.Turn(invalid_future, "assistant-uninstall-discovery"),
                "team_1",
            )
            self.assertEqual(invalid["status"], 503)

            inactive_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            inactive_future.set_result(self._uninstall_candidate())
            self.assertIsNone(
                await delivery._candidate_event(
                    delivery.Connection(closed=True),
                    delivery.Turn(inactive_future, "assistant-uninstall-discovery"),
                    "team_1",
                )
            )

            with mock.patch.object(
                delivery.history_delivery,
                "guidance",
                new=mock.AsyncMock(side_effect=delivery.history.HistoryUnavailableError),
            ):
                unavailable = await delivery._target_required_event(
                    "team_1",
                    delivery.Turn(None, "assistant-uninstall-discovery"),
                )
            self.assertEqual(unavailable["status"], 503)

            with mock.patch.object(delivery.lifecycle, "create_proposal", side_effect=ValueError):
                malformed = delivery._matched_event(
                    delivery.Connection(),
                    delivery.Turn(None, "assistant-uninstall-discovery"),
                    "team_1",
                    self._uninstall_candidate(),
                )
            self.assertEqual(malformed["status"], 503)

            cancelled_future: concurrent.futures.Future[object] = concurrent.futures.Future()
            cancelled_future.cancel()
            cancelled_turn = delivery.Turn(cancelled_future, "assistant-uninstall-discovery")
            active = delivery.Connection(active=cancelled_turn)
            with self.assertRaises(asyncio.CancelledError):
                await delivery.deliver(mock.AsyncMock(), active, cancelled_turn, "team_1")
            self.assertIsNone(active.active)

            no_event_turn = delivery.Turn(None, "assistant-uninstall-discovery")
            no_event = delivery.Connection(active=no_event_turn)
            with mock.patch.object(delivery, "_candidate_event", new=mock.AsyncMock(return_value=None)):
                await delivery.deliver(mock.AsyncMock(), no_event, no_event_turn, "team_1")
            self.assertIsNone(no_event.active)

            stopped_turn = delivery.Turn(None, "assistant-uninstall-discovery", stop_requested=True)
            stopped = delivery.Connection(active=stopped_turn)
            with mock.patch.object(
                delivery,
                "_candidate_event",
                new=mock.AsyncMock(return_value={"type": "error", "status": 503}),
            ):
                await delivery.deliver(mock.AsyncMock(), stopped, stopped_turn, "team_1")
            self.assertIsNone(stopped.active)

            detached_turn = delivery.Turn(None, "assistant-uninstall-discovery")
            detached = delivery.Connection()
            with mock.patch.object(
                delivery.terminal_delivery,
                "turn",
                new=mock.AsyncMock(return_value=True),
            ) as terminal:
                await delivery.deliver(mock.AsyncMock(), detached, detached_turn, "team_1")
            terminal.assert_awaited_once()
            self.assertIsNone(detached.active)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
