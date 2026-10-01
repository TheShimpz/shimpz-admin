"""Brain helper operations via Local Team resolve one request-scoped model credential and strip trace ids."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import models
from team import bridge as team

from chat import local

TRACE_ID = "a" * 32


class LocalBrainOperationTests(unittest.TestCase):
    def test_capability_plan_uses_one_request_scoped_credential_and_strips_trace(self) -> None:
        api_key = "sk-test-0123456789"
        candidates = [
            {
                "id": "cloudflare",
                "name": "Cloudflare",
                "summary": "Manages domains.",
                "actions": ["configure-domain"],
                "integrations": [{"id": "cloudflare", "provider": "cloudflare"}],
            }
        ]
        upstream = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "status": "install-required",
                "assistant_ids": ["cloudflare"],
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(
                team,
                "get_inference",
                return_value=team.TeamResponse(200, {"provider": "openai", "model": "gpt-6-luna"}),
            ),
            mock.patch.object(models, "resolve_api_key", return_value=api_key),
            mock.patch.object(team, "capability_plan", return_value=upstream) as plan,
        ):
            response = local.capability_plan("team_1", "Configure meu domínio", candidates)

        self.assertEqual(
            response,
            team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "status": "install-required",
                    "assistant_ids": ["cloudflare"],
                },
            ),
        )
        plan.assert_called_once_with(
            "team_1",
            {"objective": "Configure meu domínio", "candidates": candidates},
            provider="openai",
            api_key=api_key,
        )
        self.assertNotIn(api_key, repr(response))
        self.assertNotIn("trace_id", response.body)

    def test_capability_plan_rejects_nonclosed_or_inconsistent_team_output(self) -> None:
        base = {
            "team_id": "team_1",
            "status": "install-required",
            "assistant_ids": ["cloudflare"],
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**base, "team_id": "team_2"},
            {**base, "assistant_ids": ["cloudflare", "cloudflare"]},
            {**base, "status": "sufficient"},
            {**base, "trace_id": "bad"},
            {**base, "extra": True},
        )
        for body in invalid:
            with (
                self.subTest(body=body),
                mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
                mock.patch.object(team, "capability_plan", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    local.capability_plan("team_1", "Configure Cloudflare", []),
                    team.TeamResponse(502, {"code": "chat-response-invalid"}),
                )

    def test_intent_route_uses_one_request_scoped_credential_and_strips_trace(self) -> None:
        api_key = "sk-test-0123456789"
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        upstream = team.TeamResponse(
            200,
            {
                "task_follows": False,
                "team_id": "team_1",
                "intent": "assistant-uninstall",
                "query": "",
                "assistant_ids": ["cloudflare"],
                "reply": "",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(
                team,
                "get_inference",
                return_value=team.TeamResponse(200, {"provider": "openai", "model": "gpt-6-luna"}),
            ),
            mock.patch.object(models, "resolve_api_key", return_value=api_key),
            mock.patch.object(team, "intent_route", return_value=upstream) as route,
        ):
            response = local.intent_route(
                "team_1",
                "desinstale o cloudflare",
                "assistant-uninstall",
                candidates,
                local.IntentRouteContext(locale="pt"),
            )

        self.assertEqual(
            response,
            team.TeamResponse(
                200,
                {
                    "task_follows": False,
                    "team_id": "team_1",
                    "intent": "assistant-uninstall",
                    "query": "",
                    "assistant_ids": ["cloudflare"],
                    "reply": "",
                },
            ),
        )
        route.assert_called_once_with(
            "team_1",
            {
                "objective": "desinstale o cloudflare",
                "expected_intent": "assistant-uninstall",
                "candidates": candidates,
                "lifecycle_reference": None,
                "conversation": [],
                "locale": "pt",
            },
            provider="openai",
            api_key=api_key,
            decision_key=None,
        )
        self.assertNotIn(api_key, repr(response))
        self.assertNotIn("trace_id", response.body)

    def test_intent_route_task_continuation_is_only_a_targeted_install_classification(self) -> None:
        body = {
            "task_follows": True,
            "team_id": "team_1",
            "intent": "assistant-install",
            "query": "exa",
            "assistant_ids": [],
            "reply": "",
            "trace_id": TRACE_ID,
        }
        projected = local._project_intent_route(team.TeamResponse(200, body), "team_1", None, [])
        self.assertTrue(projected.body["task_follows"])
        for invalid, expected in (
            ({**body, "task_follows": "yes"}, None),
            ({**body, "intent": "ordinary-task", "query": ""}, None),
            ({**body, "query": "", "reply": "Qual?"}, None),
            ({**body, "query": "", "assistant_ids": ["exa"]}, "assistant-install"),
        ):
            with self.subTest(body=invalid), self.assertRaises(ValueError):
                local._project_intent_route(team.TeamResponse(200, invalid), "team_1", expected, ["exa"])


if __name__ == "__main__":
    unittest.main()
