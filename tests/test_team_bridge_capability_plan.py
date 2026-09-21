"""Private Admin-to-Team stateless capability planner bridge."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

API_KEY = "sk-test-0123456789"


class TeamCapabilityPlanBridgeTests(unittest.TestCase):
    def test_calls_only_the_fixed_route_with_private_model_binding(self) -> None:
        payload = {
            "objective": "Configure meu domínio",
            "candidates": [
                {
                    "id": "cloudflare",
                    "name": "Cloudflare",
                    "summary": "Manages domains.",
                    "actions": ["configure-domain"],
                    "integrations": [{"id": "cloudflare", "provider": "cloudflare"}],
                }
            ],
        }
        expected = team.TeamResponse(200, {"status": "sufficient"})
        with mock.patch.object(team, "_call", return_value=expected) as call:
            response = team.capability_plan(
                "team_1",
                payload,
                provider="openai",
                api_key=API_KEY,
            )

        self.assertIs(response, expected)
        call.assert_called_once_with(
            "POST",
            "/v1/teams/team_1/chat/capability-plan",
            payload,
            model_credential=("openai", API_KEY),
            timeout=team.CAPABILITY_PLAN_TIMEOUT_SECONDS,
        )
        self.assertNotIn(API_KEY, repr(response))

    def test_rejects_added_or_missing_payload_fields_before_team(self) -> None:
        invalid = (
            {"objective": "Configure Cloudflare"},
            {"objective": "Configure Cloudflare", "candidates": [], "extra": True},
            [],
        )
        for payload in invalid:
            with (
                self.subTest(payload=payload),
                mock.patch.object(team, "_call") as call,
                self.assertRaises(team.TeamRequestError),
            ):
                team.capability_plan(
                    "team_1",
                    payload,
                    provider="openai",
                    api_key=API_KEY,
                )
            call.assert_not_called()

    def test_intent_route_calls_only_the_fixed_route_with_private_model_binding(self) -> None:
        payload = {
            "objective": "desinstale o cloudflare",
            "expected_intent": "assistant-uninstall",
            "candidates": [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}],
            "lifecycle_reference": None,
            "conversation": [],
            "language_exemplar": None,
        }
        expected = team.TeamResponse(200, {"intent": "assistant-uninstall"})
        with mock.patch.object(team, "_call", return_value=expected) as call:
            response = team.intent_route(
                "team_1",
                payload,
                provider="openai",
                api_key=API_KEY,
            )

        self.assertIs(response, expected)
        call.assert_called_once_with(
            "POST",
            "/v1/teams/team_1/chat/intent-route",
            payload,
            model_credential=("openai", API_KEY),
            timeout=team.INTENT_ROUTE_TIMEOUT_SECONDS,
        )
        self.assertNotIn(API_KEY, repr(response))

    def test_intent_route_rejects_added_or_missing_payload_fields_before_team(self) -> None:
        invalid = (
            {"objective": "hello", "expected_intent": None},
            {
                "objective": "hello",
                "expected_intent": None,
                "candidates": [],
                "lifecycle_reference": None,
                "conversation": [],
                "language_exemplar": None,
                "extra": True,
            },
            {
                "objective": "hello",
                "expected_intent": None,
                "candidates": [],
                "lifecycle_reference": None,
                "conversation": [],
                "language_exemplar": None,
                "pending_intent": "assistant-uninstall",
            },
            [],
        )
        for payload in invalid:
            with (
                self.subTest(payload=payload),
                mock.patch.object(team, "_call") as call,
                self.assertRaises(team.TeamRequestError),
            ):
                team.intent_route(
                    "team_1",
                    payload,
                    provider="openai",
                    api_key=API_KEY,
                )
            call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
