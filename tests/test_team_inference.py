"""Fast contracts for secret-free Team inference metadata."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

TRACE_GET = "0123456789abcdef0123456789abcdef"
TRACE_PUT = "fedcba9876543210fedcba9876543210"


class TeamInferenceTests(unittest.TestCase):
    def test_get_and_put_project_the_real_controller_envelope(self) -> None:
        responses = (
            team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "provider": "openai",
                    "model": "gpt-5.5",
                    "trace_id": TRACE_GET,
                },
            ),
            team.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "provider": "anthropic",
                    "model": "claude-sonnet-5",
                    "trace_id": TRACE_PUT,
                },
            ),
        )
        with mock.patch.object(team, "_call", side_effect=responses) as call:
            self.assertEqual(
                team.get_inference("team_1"),
                team.TeamResponse(
                    200,
                    {"team_id": "team_1", "provider": "openai", "model": "gpt-5.5"},
                ),
            )
            self.assertEqual(
                team.configure_inference(
                    "team_1",
                    {"provider": "anthropic", "model": "claude-sonnet-5"},
                ),
                team.TeamResponse(
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

    def test_rejects_mismatched_team_or_invalid_trace(self) -> None:
        invalid_responses = (
            {
                "team_id": "team_2",
                "provider": "openai",
                "model": "gpt-5.5",
                "trace_id": TRACE_GET,
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-5.5",
                "trace_id": "not-a-trace",
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-5.5",
                "trace_id": TRACE_GET.upper(),
            },
        )
        for body in invalid_responses:
            with (
                self.subTest(body=body),
                mock.patch.object(team, "_call", return_value=team.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    team.get_inference("team_1"),
                    team.TeamResponse(502, {"detail": "Team inference response is invalid."}),
                )

    def test_rejects_secret_bearing_or_extra_controller_metadata_without_reflecting_it(self) -> None:
        secret = "-".join(("sk", "private", "controller", "marker"))
        invalid_responses = (
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-5.5",
                "trace_id": TRACE_GET,
                "api_key": secret,
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-5.5",
                "trace_id": TRACE_GET,
                "internal": "controller detail",
            },
        )
        for body in invalid_responses:
            with (
                self.subTest(body=body),
                mock.patch.object(
                    team,
                    "_call",
                    return_value=team.TeamResponse(200, body),
                ),
            ):
                projected = team.get_inference("team_1")
                self.assertEqual(
                    projected,
                    team.TeamResponse(502, {"detail": "Team inference response is invalid."}),
                )
                self.assertNotIn(secret, repr(projected.body))

    def test_preserves_bounded_non_success_controller_status(self) -> None:
        response = team.TeamResponse(409, {"detail": "not configured"})
        with mock.patch.object(team, "_call", return_value=response):
            self.assertIs(team.get_inference("team_1"), response)

    def test_rejects_secrets_and_retired_cli_providers_before_network_io(self) -> None:
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
        with mock.patch.object(team, "_call") as call:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(team.TeamRequestError):
                    team.configure_inference("team_1", payload)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
