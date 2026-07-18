"""Fast contracts for secret-free Team inference metadata."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import teams


class TeamInferenceTests(unittest.TestCase):
    def test_forwards_only_provider_and_model_to_fixed_routes(self) -> None:
        response = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        with mock.patch.object(teams, "_call", return_value=response) as call:
            self.assertIs(teams.get_inference("team_1"), response)
            self.assertIs(
                teams.configure_inference(
                    "team_1",
                    {"provider": "anthropic", "model": "claude-sonnet-5"},
                ),
                response,
            )

        self.assertEqual(
            call.call_args_list,
            [
                mock.call("GET", "/v1/teams/team_1/inference"),
                mock.call(
                    "PUT",
                    "/v1/teams/team_1/inference",
                    {"provider": "anthropic", "model": "claude-sonnet-5"},
                ),
            ],
        )

    def test_rejects_secrets_and_legacy_cli_providers_before_network_io(self) -> None:
        payloads = (
            {"provider": "openai", "model": "gpt-5.5", "api_key": "must-not-cross"},
            {"provider": "codex", "model": "gpt-5.5"},
            {"provider": "claude-code", "model": "claude-sonnet-5"},
            {"provider": "anthropic", "model": "bad model"},
            {"provider": "anthropic", "model": "gpt-5.6-terra"},
            {"provider": "openai", "model": "claude-sonnet-5"},
            {"provider": "openai", "model": "gpt-5.7"},
            {"provider": "OpenAI", "model": "gpt-5.6-terra"},
        )
        with mock.patch.object(teams, "_call") as call:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    teams.configure_inference("team_1", payload)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
