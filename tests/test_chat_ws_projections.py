"""Pure public-event projection contracts for Admin chat WebSockets."""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

import chat_ws_fixtures as fixtures

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class ChatWebSocketProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.chat_ws = importlib.import_module("chat_ws")
        cls.teams = importlib.import_module("teams")

    def test_integration_events_are_exact_and_never_project_oauth_material(self) -> None:
        expected = {
            "type": "integrations-required",
            "challenge_id": fixtures.CHALLENGE_ID,
            "expires_in": 300,
            "requirements": fixtures.integration_requirements(),
        }
        self.assertEqual(self.chat_ws.integration_challenge_event(fixtures.integration_challenge(), "team_1"), expected)

        cross_team = self.chat_ws.localchat.PublicResponse(
            200,
            {**dict(fixtures.integration_challenge().body), "team_id": "other_team"},
        )
        self.assertIsNone(self.chat_ws.integration_challenge_event(cross_team, "team_1"))
        with self.assertRaises(TypeError):
            fixtures.integration_challenge().body["access_token"] = "must-not-cross"
