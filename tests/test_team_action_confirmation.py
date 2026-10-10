"""The Supervisor's Action confirmation setting for a Team (ADR-0112), projected from Team exactly."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi import HTTPException
from http_request import LOOPBACK, http_request, json_headers
from team import bridge as team
from team import inference as routes

TRACE = "0123456789abcdef0123456789abcdef"


def _team(enabled: object, **extra: object) -> team.TeamResponse:
    return team.TeamResponse(200, {"team_id": "team_1", "confirm_mutating": enabled, "trace_id": TRACE, **extra})


class ActionConfirmationBridgeTests(unittest.TestCase):
    def test_get_and_put_project_exactly_the_team_and_its_setting(self) -> None:
        with mock.patch.object(team, "_call", side_effect=(_team(True), _team(False))) as call:
            self.assertEqual(
                team.get_action_confirmation("team_1"),
                team.TeamResponse(200, {"team_id": "team_1", "confirm_mutating": True}),
            )
            self.assertEqual(
                team.configure_action_confirmation("team_1", {"confirm_mutating": False}),
                team.TeamResponse(200, {"team_id": "team_1", "confirm_mutating": False}),
            )
        self.assertEqual(
            call.call_args_list,
            [
                mock.call("GET", "/v1/teams/team_1/action-confirmation"),
                mock.call("PUT", "/v1/teams/team_1/action-confirmation", {"confirm_mutating": False}),
            ],
        )

    def test_only_one_boolean_reaches_team(self) -> None:
        with mock.patch.object(team, "_call") as call:
            for payload in (
                {},
                {"confirm_mutating": 1},
                {"confirm_mutating": "false"},
                {"confirm_mutating": None},
                {"confirm_mutating": True, "team_id": "team_1"},
                [True],
            ):
                with self.subTest(payload=payload), self.assertRaises(team.TeamRequestError):
                    team.configure_action_confirmation("team_1", payload)
            with self.assertRaises(team.TeamRequestError):
                team.get_action_confirmation("Team 1")
        call.assert_not_called()

    def test_an_invalid_or_mismatched_team_answer_is_refused_without_reflection(self) -> None:
        invalid = (
            _team(1),
            _team("true"),
            _team(True, extra="leak"),
            team.TeamResponse(200, {"team_id": "team_2", "confirm_mutating": True}),
            team.TeamResponse(200, {"team_id": "team_1", "confirm_mutating": True, "trace_id": "x"}),
            team.TeamResponse(200, {"team_id": "team_1"}),
        )
        for answer in invalid:
            with (
                self.subTest(answer=answer),
                mock.patch.object(team, "_call", return_value=answer),
                self.assertLogs("shimpz-admin", level="WARNING"),
            ):
                self.assertEqual(team.get_action_confirmation("team_1").status, 502)
        # A PUT Team answered with another value than the Supervisor chose is not this change.
        with mock.patch.object(team, "_call", return_value=_team(True)), self.assertLogs("shimpz-admin", "WARNING"):
            self.assertEqual(team.configure_action_confirmation("team_1", {"confirm_mutating": False}).status, 502)

    def test_a_team_refusal_keeps_its_status_and_safe_body(self) -> None:
        refusal = team.TeamResponse(404, {"code": "team-not-found"})
        with mock.patch.object(team, "_call", return_value=refusal):
            self.assertIs(team.get_action_confirmation("team_1"), refusal)


class ActionConfirmationRouteTests(unittest.TestCase):
    def test_the_routes_forward_the_supervisor_body_and_answer_its_projection(self) -> None:
        answer = team.TeamResponse(200, {"team_id": "team_1", "confirm_mutating": False})
        with mock.patch.object(team, "get_action_confirmation", return_value=answer) as read:
            response = routes.action_confirmation_status("team_1")
        read.assert_called_once_with("team_1")
        self.assertEqual((response.status_code, json.loads(response.body)), (200, answer.body))

        raw = json.dumps({"confirm_mutating": False}).encode()
        request = http_request(
            "/api/teams/team_1/action-confirmation", LOOPBACK, method="PUT", body=raw, headers=json_headers(raw)
        )
        with mock.patch.object(team, "configure_action_confirmation", return_value=answer) as write:
            response = asyncio.run(routes.action_confirmation_configure("team_1", request))
        write.assert_called_once_with("team_1", {"confirm_mutating": False})
        self.assertEqual(response.status_code, 200)

    def test_an_invalid_body_is_a_bad_request(self) -> None:
        raw = json.dumps({"confirm_mutating": "no"}).encode()
        request = http_request(
            "/api/teams/team_1/action-confirmation", LOOPBACK, method="PUT", body=raw, headers=json_headers(raw)
        )
        with mock.patch.object(team, "_call") as call, self.assertRaises(HTTPException) as refused:
            asyncio.run(routes.action_confirmation_configure("team_1", request))
        self.assertEqual(refused.exception.status_code, 400)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
