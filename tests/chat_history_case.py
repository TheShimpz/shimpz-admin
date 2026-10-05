"""Shared isolated store and recorded-event fixtures for the Admin chat history suites."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import store as history


def installed_event() -> dict[str, object]:
    return {
        "type": "assistant-install-plan",
        "state": "installed",
        "plan_id": "a" * 32,
        "team_id": "marketing",
        "assistants": [
            {
                "id": "shimpz-cloudflare",
                "name": "Shimpz Cloudflare",
                "summary": "Manage DNS records.",
                "providers": ["cloudflare"],
                "provenance": "local",
                "status": "installed",
            }
        ],
        "continuation": "dispatch",
    }


def uninstall_assistant() -> dict[str, str]:
    return {
        "id": "shimpz-cloudflare",
        "name": "Shimpz Cloudflare",
        "version": "0.4.5",
    }


class ChatHistoryCase(unittest.TestCase):
    """Give every test its own history database at self.path."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "chat-history.sqlite3"
        path_patch = mock.patch.object(history, "STORE_PATH", self.path)
        path_patch.start()
        self.addCleanup(path_patch.stop)

    @staticmethod
    def _admitted(team_id: str = "marketing") -> str:
        # Every turn event follows its admitted user row, as chat delivery writes it.
        turn = history.new_turn_id()
        history.append_user(team_id, turn, "Request")
        return turn
