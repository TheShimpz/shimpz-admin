"""Private Admin-to-Team stateless capability planner bridge."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import transport

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
        expected = transport.TeamResponse(200, {"status": "sufficient"})
        with mock.patch.object(transport, "call", return_value=expected) as call:
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
            bounds=team.transport.ByteBounds(body=team.team_turn.MAX_CAPABILITY_PLAN_BODY_BYTES),
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
                mock.patch.object(transport, "call") as call,
                self.assertRaises(transport.TeamRequestError),
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
            "locale": "pt",
        }
        expected = transport.TeamResponse(200, {"intent": "assistant-uninstall"})
        with mock.patch.object(transport, "call", return_value=expected) as call:
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
            decision_key=None,
            timeout=team.INTENT_ROUTE_TIMEOUT_SECONDS,
            bounds=team.transport.ByteBounds(body=team.team_turn.MAX_INTENT_ROUTE_BODY_BYTES),
        )
        self.assertNotIn(API_KEY, repr(response))

    def test_the_longest_admissible_message_is_routed_and_planned(self) -> None:
        # 16,000 four-byte code points: a chat message Admin admits, 64 KB once encoded.
        objective = "\U0001f600" * team.team_contract.MAX_CHAT_MESSAGE_CHARS
        route = {
            "objective": objective,
            "expected_intent": None,
            "candidates": [],
            "lifecycle_reference": None,
            "conversation": [],
            "locale": "pt",
        }
        expected = transport.TeamResponse(200, {"intent": "ordinary-task"})
        with mock.patch.object(team.transport, "_request", return_value=expected) as request:
            self.assertIs(team.intent_route("team_1", route, provider="openai", api_key=API_KEY), expected)
            plan = {"objective": objective, "candidates": []}
            self.assertIs(team.capability_plan("team_1", plan, provider="openai", api_key=API_KEY), expected)
        sent = [call.args[2].body for call in request.call_args_list]
        self.assertTrue(all(len(body) > team.transport.MAX_JSON_BODY_BYTES for body in sent))

    def test_intent_route_rejects_added_or_missing_payload_fields_before_team(self) -> None:
        # The complete body lacks only its locale; each variant adds or omits fields explicitly.
        without_locale = {
            "objective": "hello",
            "expected_intent": None,
            "candidates": [],
            "lifecycle_reference": None,
            "conversation": [],
        }
        invalid = (
            {"objective": "hello", "expected_intent": None},
            {**without_locale, "locale": "pt", "extra": True},
            without_locale,
            [],
        )
        for payload in invalid:
            with (
                self.subTest(payload=payload),
                mock.patch.object(transport, "call") as call,
                self.assertRaises(transport.TeamRequestError),
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
