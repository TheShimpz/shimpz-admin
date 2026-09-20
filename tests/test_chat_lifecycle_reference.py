"""Identity-only lifecycle reference contracts at the Admin-to-Team boundary."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

from chat import assistant_proposal, local


class ChatLifecycleReferenceTests(unittest.TestCase):
    def test_reference_is_classification_only_and_crosses_as_identity_only(self) -> None:
        reference = assistant_proposal.AssistantReference("cloudflare", "Cloudflare")
        with (
            mock.patch.object(local, "_model_credential", return_value=("openai", "secret")),
            mock.patch.object(team, "intent_route", return_value=team.TeamResponse(503, {})) as route,
        ):
            local.intent_route("team_1", "instale ele de novo", None, [], reference)

        self.assertEqual(
            route.call_args.args[1]["lifecycle_reference"],
            {"id": "cloudflare", "name": "Cloudflare"},
        )
        candidates = [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}]
        with self.assertRaises(team.TeamRequestError):
            local.intent_route("team_1", "instale o cloudflare", "assistant-install", candidates, reference)


if __name__ == "__main__":
    unittest.main()
