"""Shared authenticated Admin chat WebSocket test authority."""

from __future__ import annotations

import concurrent.futures
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.mfa_helper import configure_supervisor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class ChatWebSocketCase(unittest.TestCase):
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
        cls.assistant_route = importlib.import_module("chat.assistant_route")
        cls.team = importlib.import_module("team.bridge")
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
        route = mock.patch.object(
            self.chat_socket.lifecycle,
            "submit_route",
            side_effect=lambda _team_id, _payload: self._route_future(
                self.assistant_plan.Preparation()
            ),
        )
        route.start()
        self.addCleanup(route.stop)

    def _install_candidate(self):
        return self.chat_socket.lifecycle.store_catalog.CatalogAssistant(
            assistant_id="shimpz-cloudflare",
            name="Shimpz Cloudflare",
            summary="Manage Cloudflare zones and DNS records.",
            source_digest="sha256:" + ("d" * 64),
            icon_digest="sha256:" + ("e" * 64),
            integrations=(self.chat_socket.lifecycle.store_catalog.CatalogIntegration("cloudflare", ("zone.read",)),),
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

    def _route_future(self, preparation, intent="ordinary-task"):
        return self._future(self.assistant_route.Result(intent, preparation=preparation))

    @staticmethod
    def _accepted(message: dict) -> bool:
        return message == {"type": "websocket.accept", "subprotocol": "shimpz.chat.v7", "headers": []}
