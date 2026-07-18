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
    def test_forwards_only_provider_and_model_and_adds_browser_team_authority(self) -> None:
        responses = (
            teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"}),
            teams.DriverResponse(200, {"provider": "anthropic", "model": "claude-sonnet-5"}),
        )
        with mock.patch.object(teams, "_call", side_effect=responses) as call:
            self.assertEqual(
                teams.get_inference("team_1"),
                teams.DriverResponse(
                    200,
                    {"team_id": "team_1", "provider": "openai", "model": "gpt-5.5"},
                ),
            )
            self.assertEqual(
                teams.configure_inference(
                    "team_1",
                    {"provider": "anthropic", "model": "claude-sonnet-5"},
                ),
                teams.DriverResponse(
                    200,
                    {
                        "team_id": "team_1",
                        "provider": "anthropic",
                        "model": "claude-sonnet-5",
                    },
                ),
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

    def test_rejects_secret_bearing_or_invalid_controller_metadata_without_reflecting_it(self) -> None:
        secret = "sk-private-controller-marker"
        invalid_responses = (
            {"provider": "openai", "model": "gpt-5.5", "api_key": secret},
            {"provider": "openai", "model": "claude-sonnet-5"},
            {"provider": "OpenAI", "model": "gpt-5.5"},
            {"provider": "openai"},
        )
        for body in invalid_responses:
            with self.subTest(body=body), mock.patch.object(
                teams,
                "_call",
                return_value=teams.DriverResponse(200, body),
            ):
                projected = teams.get_inference("team_1")
                self.assertEqual(
                    projected,
                    teams.DriverResponse(502, {"detail": "Team inference response is invalid."}),
                )
                self.assertNotIn(secret, repr(projected.body))

    def test_preserves_bounded_non_success_controller_status(self) -> None:
        response = teams.DriverResponse(409, {"detail": "not configured"})
        with mock.patch.object(teams, "_call", return_value=response):
            self.assertIs(teams.get_inference("team_1"), response)

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
