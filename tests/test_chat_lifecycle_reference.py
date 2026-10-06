"""Identity-only lifecycle reference contracts at the Admin-to-Team boundary."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from history import context as conversation_context
from team import bridge as team

from chat import assistant_proposal, local

TRACE_ID = "a" * 32
EN = local.IntentRouteContext(locale="en")


class ChatLifecycleReferenceTests(unittest.TestCase):
    def test_reference_is_classification_only_and_crosses_as_identity_only(self) -> None:
        reference = assistant_proposal.AssistantReference("cloudflare", "Cloudflare")
        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(503, {})) as route,
        ):
            local.intent_route(
                "team_1",
                "instale ele de novo",
                None,
                [],
                local.IntentRouteContext(
                    reference=reference,
                    conversation=(conversation_context.Entry("assistant", "Cloudflare foi desinstalado.", False),),
                    locale="pt",
                ),
            )

        self.assertEqual(
            route.call_args.args[1]["lifecycle_reference"],
            {"id": "cloudflare", "name": "Cloudflare"},
        )
        self.assertEqual(
            route.call_args.args[1]["conversation"],
            [{"role": "assistant", "text": "Cloudflare foi desinstalado.", "truncated": False}],
        )
        self.assertEqual(route.call_args.args[1]["locale"], "pt")
        self.assertNotIn("language_exemplar", route.call_args.args[1])
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        with self.assertRaises(team.TeamRequestError):
            local.intent_route(
                "team_1",
                "instale o cloudflare",
                "assistant-install",
                candidates,
                local.IntentRouteContext(reference=reference, locale="pt"),
            )

    def test_intent_route_rejects_invalid_input_and_inconsistent_team_output(self) -> None:
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        invalid_input = (
            ("unknown", candidates),
            (None, candidates),
            ("assistant-install", "invalid"),
            ("assistant-install", [{"id": "cloudflare", "name": "Cloudflare"}]),
            ("assistant-install", [*candidates, *candidates]),
            ("assistant-uninstall", [{"id": "cloudflare", "name": "Cloudflare", "summary": "private"}]),
        )
        for expected, directory in invalid_input:
            with self.subTest(expected=expected, directory=directory), self.assertRaises(team.TeamRequestError):
                local.intent_route("team_1", "objective", expected, directory, local.IntentRouteContext(locale="en"))

        invalid_context = (
            (None, [], object()),
            (
                None,
                [],
                local.IntentRouteContext(
                    conversation=[],
                    locale="en",
                ),
            ),
            (
                None,
                [],
                local.IntentRouteContext(
                    conversation=(conversation_context.Entry("system", "remove it", False),),
                    locale="en",
                ),
            ),
            (None, [], None),
            (None, [], local.IntentRouteContext()),
            (None, [], local.IntentRouteContext(locale="remove it")),
            (
                "assistant-uninstall",
                candidates,
                local.IntentRouteContext(locale="EN"),
            ),
            (
                "assistant-install",
                candidates,
                local.IntentRouteContext(
                    conversation=(conversation_context.Entry("user", "install it", False),),
                    locale="en",
                ),
            ),
        )
        with mock.patch.object(team, "intent_route") as route:
            for expected, directory, context in invalid_context:
                with self.subTest(context=context), self.assertRaises(team.TeamRequestError):
                    local.intent_route("team_1", "objective", expected, directory, context)
        route.assert_not_called()

        base = {
            "task_follows": False,
            "team_id": "team_1",
            "intent": "assistant-uninstall",
            "query": "",
            "assistant_ids": ["cloudflare"],
            "reply": "",
            "trace_id": TRACE_ID,
        }
        invalid_output = (
            {**base, "team_id": "team_2"},
            {**base, "assistant_ids": ["unknown"]},
            {**base, "assistant_ids": []},
            {**base, "intent": "assistant-install"},
            {**base, "query": "cloudflare"},
            {**base, "trace_id": "bad"},
            {**base, "extra": True},
        )
        for body in invalid_output:
            with (
                self.subTest(body=body),
                mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
                mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    local.intent_route(
                        "team_1",
                        "desinstale o cloudflare",
                        "assistant-uninstall",
                        candidates,
                        EN,
                    ),
                    team.TeamResponse(502, {"code": "chat-response-invalid"}),
                )

        valid_classification = {**base, "intent": "ordinary-task", "assistant_ids": []}
        classification_invalid = (
            {**valid_classification, "query": "unexpected"},
            {**valid_classification, "intent": "unresolved", "query": "unexpected"},
            {**valid_classification, "reply": "Unexpected guidance"},
        )
        for body in classification_invalid:
            with (
                self.subTest(body=body),
                mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
                mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    local.intent_route("team_1", "faça isso", None, [], EN),
                    team.TeamResponse(502, {"code": "chat-response-invalid"}),
                )

        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
            mock.patch.object(
                team,
                "intent_route",
                return_value=team.TeamResponse(200, valid_classification),
            ),
        ):
            self.assertEqual(
                local.intent_route("team_1", "faça isso", None, [], EN),
                team.TeamResponse(
                    200,
                    {key: value for key, value in valid_classification.items() if key != "trace_id"},
                ),
            )

        invalid_unresolved = {**valid_classification, "intent": "unresolved", "query": "unexpected"}
        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, invalid_unresolved)),
        ):
            self.assertEqual(
                local.intent_route("team_1", "instale", "assistant-install", candidates, EN),
                team.TeamResponse(502, {"code": "chat-response-invalid"}),
            )

        valid_unresolved = {**invalid_unresolved, "query": "", "reply": "Qual Assistant você quer instalar?"}
        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(200, valid_unresolved)),
        ):
            self.assertEqual(
                local.intent_route("team_1", "instale", "assistant-install", candidates, EN),
                team.TeamResponse(
                    200,
                    {key: value for key, value in valid_unresolved.items() if key != "trace_id"},
                ),
            )


if __name__ == "__main__":
    unittest.main()
