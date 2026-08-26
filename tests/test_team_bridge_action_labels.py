"""Private Admin-to-Team Action label bridge contract."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team

API_KEY = "sk-test-0123456789"
INVALID_RESPONSE = team.TeamResponse(502, {"detail": "Team Action label response is invalid."})


def _body(**changes: object) -> dict[str, object]:
    body: dict[str, object] = {
        "team_id": "team_1",
        "assistant": "hello-pulse",
        "assistant_version": "1.2.3",
        "actions": [
            {"id": "list-zones", "label": "Listar zonas DNS"},
            {"id": "records.read", "label": "Consultar registros DNS"},
        ],
        "trace_id": "f" * 32,
    }
    body.update(changes)
    return body


class TeamActionLabelBridgeTest(unittest.TestCase):
    def test_calls_only_the_fixed_route_with_private_model_binding(self) -> None:
        upstream = team.TeamResponse(200, _body())
        with mock.patch.object(team, "_call", return_value=upstream) as call:
            response = team.assistant_action_labels(
                "team_1",
                "hello-pulse",
                "Liste minhas zonas DNS",
                provider="openai",
                api_key=API_KEY,
            )

        call.assert_called_once_with(
            "POST",
            "/v1/teams/team_1/assistants/hello-pulse/action-labels",
            {"language_exemplar": "Liste minhas zonas DNS"},
            model_credential=("openai", API_KEY),
        )
        self.assertEqual(
            response.body,
            {
                "team_id": "team_1",
                "assistant": "hello-pulse",
                "assistant_version": "1.2.3",
                "actions": _body()["actions"],
            },
        )
        self.assertNotIn(API_KEY, repr(response))

    def test_rejects_invalid_input_before_calling_team(self) -> None:
        with (
            mock.patch.object(team, "_call") as call,
            self.assertRaises(team.TeamRequestError),
        ):
            team.assistant_action_labels(
                "team_1",
                "hello-pulse",
                " non-canonical ",
                provider="openai",
                api_key=API_KEY,
            )
        call.assert_not_called()

    def test_preserves_only_ordinary_error_statuses(self) -> None:
        for status, expected in (
            (409, team.TeamResponse(409, {"code": "team-context-changed"})),
            (503, team.TeamResponse(503, {"code": "action-labels-unavailable"})),
            (201, INVALID_RESPONSE),
        ):
            upstream = team.TeamResponse(status, expected.body)
            with self.subTest(status=status), mock.patch.object(team, "_call", return_value=upstream):
                self.assertEqual(
                    team.assistant_action_labels(
                        "team_1",
                        "hello-pulse",
                        "Liste minhas zonas DNS",
                        provider="openai",
                        api_key=API_KEY,
                    ),
                    expected,
                )

    def test_rejects_cross_scope_malformed_or_secret_bearing_responses(self) -> None:
        valid = _body()
        invalid = (
            _body(team_id="team_2"),
            _body(assistant="other"),
            _body(assistant_version="v1"),
            _body(actions=[]),
            _body(actions=list(reversed(valid["actions"]))),
            _body(
                actions=[
                    {"id": "list-zones", "label": "Listar zonas DNS"},
                    {"id": "records.read", "label": "Listar zonas DNS"},
                ]
            ),
            _body(actions=[{"id": "list-zones", "label": API_KEY}]),
            _body(actions=[{"id": "Bad", "label": "Listar zonas DNS"}]),
            _body(actions=[{"id": "list-zones", "label": "\u202eDNS"}]),
            {**valid, "extra": True},
        )
        for body in invalid:
            with (
                self.subTest(body=body),
                mock.patch.object(
                    team,
                    "_call",
                    return_value=team.TeamResponse(200, body),
                ),
            ):
                self.assertEqual(
                    team.assistant_action_labels(
                        "team_1",
                        "hello-pulse",
                        "Liste minhas zonas DNS",
                        provider="openai",
                        api_key=API_KEY,
                    ),
                    INVALID_RESPONSE,
                )


if __name__ == "__main__":
    unittest.main()
