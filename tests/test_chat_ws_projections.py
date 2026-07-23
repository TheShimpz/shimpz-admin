"""Pure public-event projection contracts for Admin chat WebSockets."""

from __future__ import annotations

import importlib
import json
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

    def test_secret_events_are_exact_bounded_and_never_project_values(self) -> None:
        expected_challenge = {
            "type": "secrets-required",
            "turn_id": fixtures.TURN_ID,
            "challenge_id": fixtures.CHALLENGE_ID,
            "requirements": fixtures.requirements(),
        }
        self.assertEqual(
            self.chat_ws.secret_challenge_event(fixtures.challenge(), "team_1"),
            expected_challenge,
        )
        expected_inventory = {
            "type": "secret-inventory",
            "team_id": "team_1",
            "assistants": fixtures.inventory().body["assistants"],
        }
        self.assertEqual(
            self.chat_ws.secret_inventory_event(fixtures.inventory(), "team_1"),
            expected_inventory,
        )
        self.assertNotIn("value", json.dumps(expected_challenge))

        challenge = fixtures.challenge()
        unprojected = self.teams.DriverResponse(challenge.status, dict(challenge.body))
        self.assertIsNone(self.chat_ws.secret_challenge_event(unprojected, "team_1"))
        cross_team = self.chat_ws.localchat.PublicResponse(
            200,
            {**dict(fixtures.inventory().body), "team_id": "other_team"},
        )
        self.assertIsNone(self.chat_ws.secret_inventory_event(cross_team, "team_1"))
        with self.assertRaises(TypeError):
            fixtures.inventory().body["assistants"][0]["secrets"][0]["mask"] = "secret-value"

    def test_approval_events_project_in_body_metadata_without_internal_authority(self) -> None:
        expected = {
            "type": "approval-required",
            "turn_id": fixtures.TURN_ID,
            "challenge_id": fixtures.CHALLENGE_ID,
            "requirements": fixtures.approval_requirements(),
        }
        self.assertEqual(self.chat_ws.approval_challenge_event(fixtures.approval_challenge(), "team_1"), expected)
        self.assertNotIn("api_key", json.dumps(expected))
        self.assertNotIn("secret_values", json.dumps(expected))

        with self.assertRaises(TypeError):
            fixtures.approval_challenge().body["requirements"][0]["approval"] = "each-run"

    def test_account_events_are_exact_and_never_project_oauth_material(self) -> None:
        expected = {
            "type": "accounts-required",
            "challenge_id": fixtures.CHALLENGE_ID,
            "expires_in": 300,
            "requirements": fixtures.account_requirements(),
        }
        self.assertEqual(self.chat_ws.account_challenge_event(fixtures.account_challenge(), "team_1"), expected)

        cross_team = self.chat_ws.localchat.PublicResponse(
            200,
            {**dict(fixtures.account_challenge().body), "team_id": "other_team"},
        )
        self.assertIsNone(self.chat_ws.account_challenge_event(cross_team, "team_1"))
        with self.assertRaises(TypeError):
            fixtures.account_challenge().body["access_token"] = "must-not-cross"
