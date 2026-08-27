"""Focused WebSocket projection for conversational Assistant uninstall."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
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
        previous_origins = cls.chat_socket.STATIC_ORIGINS
        cls.admin_app.state.STORE_PATH = cls.root / "admin.json"
        cls.chat_socket.STATIC_ORIGINS = frozenset(
            {"http://localhost:7777", "http://127.0.0.1:7777"}
        )
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.chat_socket, "STATIC_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
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
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "Vou preparar a remoção."},
            )
            result = self.chat_socket.lifecycle.assistant_uninstall.UninstallResult(200, True)
            with (
                mock.patch.object(self.chat_socket.local, "turn", return_value=response) as turn,
                mock.patch.object(
                    self.chat_socket.lifecycle.assistant_uninstall,
                    "discover",
                    return_value=self._uninstall_candidate(),
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
                        "message": "Desinstale o Assistant do Cloudflare",
                        "files": [],
                        "assistant_ids": ["shimpz-cloudflare"],
                    }
                )
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
                    "Desinstale o Assistant do Cloudflare",
                )
                self.assertEqual(turn.call_count, 1)
                await websocket.disconnect()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
