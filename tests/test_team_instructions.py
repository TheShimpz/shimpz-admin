"""Fast contracts for a Team's standing instructions at the Admin boundary (ADR-0083)."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import http as team_http
from team import inference as team_inference

TRACE = "0123456789abcdef0123456789abcdef"
RULES = ["Responda sempre em português do Brasil.", "Use listas curtas, sem tabelas."]
INVALID = team.TeamResponse(502, {"detail": "Team instructions response is invalid."})


class InstructionsBridgeTests(unittest.TestCase):
    def test_get_and_put_project_the_controller_envelope(self) -> None:
        responses = (
            team.TeamResponse(200, {"team_id": "team_1", "instructions": [], "trace_id": TRACE}),
            team.TeamResponse(200, {"team_id": "team_1", "instructions": RULES, "trace_id": TRACE}),
        )
        with mock.patch.object(team, "_call", side_effect=responses) as call:
            self.assertEqual(
                team_inference.get_instructions("team_1"),
                team.TeamResponse(200, {"team_id": "team_1", "instructions": []}),
            )
            self.assertEqual(
                team_inference.configure_instructions("team_1", {"instructions": RULES}),
                team.TeamResponse(200, {"team_id": "team_1", "instructions": RULES}),
            )
        self.assertEqual(
            call.call_args_list,
            [
                mock.call("GET", "/v1/teams/team_1/inference/instructions"),
                mock.call(
                    "PUT",
                    "/v1/teams/team_1/inference/instructions",
                    {"instructions": RULES},
                    max_body_bytes=team_inference.MAX_INSTRUCTIONS_BODY_BYTES,
                ),
            ],
        )

    def test_invalid_payloads_never_reach_the_team(self) -> None:
        with mock.patch.object(team, "_call") as call:
            for payload in (
                [],
                {"instructions": RULES, "extra": 1},
                {"instructions": ["Linha\nquebrada"]},
                {"instructions": [f"Regra {index}" for index in range(17)]},
            ):
                with self.subTest(payload=payload), self.assertRaises(team.TeamRequestError):
                    team_inference.configure_instructions("team_1", payload)
        call.assert_not_called()

    def test_invalid_or_foreign_controller_responses_are_never_reflected(self) -> None:
        secret = "-".join(("sk", "private", "controller", "marker"))
        for body in (
            {"team_id": "team_2", "instructions": RULES, "trace_id": TRACE},
            {"team_id": "team_1", "instructions": RULES, "trace_id": "not-a-trace"},
            {"team_id": "team_1", "instructions": RULES, "trace_id": 7},
            {"team_id": "team_1", "instructions": ["a\nb"], "trace_id": TRACE},
            {"team_id": "team_1", "instructions": RULES, "trace_id": TRACE, "api_key": secret},
            ["not", "an", "object"],
        ):
            with self.subTest(body=body), mock.patch.object(team, "_call", return_value=team.TeamResponse(200, body)):
                projected = team_inference.get_instructions("team_1")
                self.assertEqual(projected, INVALID)
                self.assertNotIn(secret, repr(projected.body))
        other = team.TeamResponse(200, {"team_id": "team_1", "instructions": RULES[:1], "trace_id": TRACE})
        with mock.patch.object(team, "_call", return_value=other):
            self.assertEqual(team_inference.configure_instructions("team_1", {"instructions": RULES}), INVALID)

    def test_a_non_success_status_passes_through(self) -> None:
        response = team.TeamResponse(503, {"detail": "unavailable"})
        with mock.patch.object(team, "_call", return_value=response):
            self.assertIs(team_inference.get_instructions("team_1"), response)


class InstructionsRouteTests(unittest.TestCase):
    def test_routes_read_a_larger_bounded_body_and_preserve_the_team_response(self) -> None:
        response = team.TeamResponse(200, {"team_id": "team_1", "instructions": RULES})
        with mock.patch.object(team_inference, "get_instructions", return_value=response):
            self.assertEqual(team_inference.team_instructions_status("team_1").status_code, 200)
        read = mock.AsyncMock(return_value={"instructions": RULES})
        with (
            mock.patch.object(team_http, "bounded_json_object", new=read),
            mock.patch.object(team_inference, "configure_instructions", return_value=response) as configure,
        ):
            saved = asyncio.run(team_inference.team_instructions_configure("team_1", mock.Mock()))
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(read.await_args.args[1], team_inference.MAX_INSTRUCTIONS_BODY_BYTES)
        configure.assert_called_once_with("team_1", {"instructions": RULES})


if __name__ == "__main__":
    unittest.main()
