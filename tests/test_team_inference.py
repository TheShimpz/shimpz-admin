"""Fast contracts for secret-free Team inference metadata."""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import transport

TRACE_GET = "0123456789abcdef0123456789abcdef"
TRACE_PUT = "fedcba9876543210fedcba9876543210"


class TeamInferenceTests(unittest.TestCase):
    def test_get_and_put_project_the_real_controller_envelope(self) -> None:
        responses = (
            transport.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "provider": "openai",
                    "model": "gpt-6-luna",
                    "trace_id": TRACE_GET,
                },
            ),
            transport.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "provider": "anthropic",
                    "model": "claude-sonnet-5-5",
                    "trace_id": TRACE_PUT,
                },
            ),
        )
        with mock.patch.object(transport, "call", side_effect=responses) as call:
            self.assertEqual(
                team.get_inference("team_1"),
                transport.TeamResponse(
                    200,
                    {"team_id": "team_1", "provider": "openai", "model": "gpt-6-luna"},
                ),
            )
            self.assertEqual(
                team.configure_inference(
                    "team_1",
                    {"provider": "anthropic", "model": "claude-sonnet-5-5"},
                ),
                transport.TeamResponse(
                    200,
                    {"team_id": "team_1", "provider": "anthropic", "model": "claude-sonnet-5-5"},
                ),
            )

        self.assertEqual(
            call.call_args_list,
            [
                mock.call("GET", "/v1/teams/team_1/inference"),
                mock.call(
                    "PUT",
                    "/v1/teams/team_1/inference",
                    {"provider": "anthropic", "model": "claude-sonnet-5-5"},
                ),
            ],
        )

    def test_a_selection_is_exactly_provider_and_model_in_both_directions(self) -> None:
        body = {"team_id": "team_1", "provider": "openai", "model": "gpt-6-luna", "trace_id": TRACE_GET, "extra": 1}
        with mock.patch.object(transport, "call", return_value=transport.TeamResponse(200, body)):
            self.assertEqual(team.get_inference("team_1").status, 502)
        for payload in ({"provider": "openai"}, {"provider": "openai", "model": "gpt-6-luna", "extra": 1}):
            with self.subTest(payload=payload), self.assertRaises(transport.TeamRequestError):
                team.configure_inference("team_1", payload)
        mismatched = transport.TeamResponse(
            200,
            {"team_id": "team_1", "provider": "openai", "model": "gpt-6.1-sol", "trace_id": TRACE_PUT},
        )
        with mock.patch.object(transport, "call", return_value=mismatched):
            self.assertEqual(
                team.configure_inference("team_1", {"provider": "openai", "model": "gpt-6-luna"}).status,
                502,
            )

    def test_rejects_mismatched_team_or_invalid_trace(self) -> None:
        invalid_responses = (
            {
                "team_id": "team_2",
                "provider": "openai",
                "model": "gpt-6-luna",
                "trace_id": TRACE_GET,
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-6-luna",
                "trace_id": "not-a-trace",
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-6-luna",
                "trace_id": TRACE_GET.upper(),
            },
        )
        for body in invalid_responses:
            with (
                self.subTest(body=body),
                mock.patch.object(transport, "call", return_value=transport.TeamResponse(200, body)),
            ):
                self.assertEqual(
                    team.get_inference("team_1"),
                    transport.TeamResponse(502, {"detail": "Team inference response is invalid."}),
                )

    def test_rejects_secret_bearing_or_extra_controller_metadata_without_reflecting_it(self) -> None:
        secret = "-".join(("sk", "private", "controller", "marker"))
        invalid_responses = (
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-6-luna",
                "trace_id": TRACE_GET,
                "api_key": secret,
            },
            {
                "team_id": "team_1",
                "provider": "openai",
                "model": "gpt-6-luna",
                "trace_id": TRACE_GET,
                "internal": "controller detail",
            },
        )
        for body in invalid_responses:
            with (
                self.subTest(body=body),
                mock.patch.object(
                    transport,
                    "call",
                    return_value=transport.TeamResponse(200, body),
                ),
            ):
                projected = team.get_inference("team_1")
                self.assertEqual(
                    projected,
                    transport.TeamResponse(502, {"detail": "Team inference response is invalid."}),
                )
                self.assertNotIn(secret, repr(projected.body))

    def test_preserves_bounded_non_success_controller_status(self) -> None:
        response = transport.TeamResponse(409, {"detail": "not configured"})
        with mock.patch.object(transport, "call", return_value=response):
            self.assertIs(team.get_inference("team_1"), response)

    def test_rejects_secrets_and_invalid_providers_before_network_io(self) -> None:
        payloads = (
            {"provider": "openai", "model": "gpt-6-luna", "api_key": "must-not-cross"},
            {"provider": "anthropic", "model": "bad model"},
            {"provider": "anthropic", "model": "gpt-6.1-sol"},
            {"provider": "openai", "model": "claude-sonnet-5-5"},
            {"provider": "openai", "model": "gpt-5.7"},
            {"provider": "OpenAI", "model": "gpt-6.1-sol"},
        )
        with mock.patch.object(transport, "call") as call:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(transport.TeamRequestError):
                    team.configure_inference("team_1", payload)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
