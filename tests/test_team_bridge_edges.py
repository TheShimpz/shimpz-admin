"""Browser-safe edge projections for the Admin Team bridge."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge


def _team(team_id: str = "team_1", team_name: str = "Marketing") -> dict[str, str]:
    return {"team_id": team_id, "team_name": team_name, "status": "running"}


def _inference() -> bridge.TeamResponse:
    return bridge.TeamResponse(
        200,
        {
            "team_id": "team_1",
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "trace_id": "a" * 32,
        },
    )


class TeamBridgeEdgeTests(unittest.TestCase):
    def test_identifiers_names_digests_and_media_types_fail_closed(self) -> None:
        operations = (
            lambda: bridge.canonical_team_name(" "),
            lambda: bridge.canonical_source_digest("sha256:bad"),
            lambda: bridge.canonical_media_type("invalid"),
        )
        for operation in operations:
            with self.assertRaises(bridge.TeamRequestError):
                operation()

    def test_simple_lifecycle_routes_use_canonical_paths(self) -> None:
        expected = bridge.TeamResponse(200, {})
        with mock.patch.object(bridge, "_call", return_value=expected) as call:
            self.assertEqual(bridge.reset_space(), expected)
            self.assertEqual(bridge.create("team_1", " Marketing "), expected)
            self.assertEqual(bridge.stop_chat("team_1"), expected)
            self.assertEqual(bridge.pending_chat_integrations("team_1"), expected)
            self.assertEqual(bridge.pending_chat_human("team_1"), expected)
        self.assertEqual(
            call.call_args_list,
            [
                mock.call("DELETE", "/v1/space"),
                mock.call("POST", "/v1/teams/team_1/create", {"team_name": "Marketing"}),
                mock.call("POST", "/v1/teams/team_1/chat/stop", {}),
                mock.call("GET", "/v1/teams/team_1/chat/integrations"),
                mock.call("GET", "/v1/teams/team_1/chat/human"),
            ],
        )
        with self.assertRaisesRegex(bridge.TeamRequestError, "team name"):
            bridge.create("team_1", " ")

    def test_authoritative_team_lookup_rejects_invalid_envelopes_and_identity(self) -> None:
        unavailable = bridge.TeamResponse(503, {"detail": "offline"})
        self.assertEqual(bridge._authoritative_team_name(unavailable, "team_1"), unavailable)

        invalid = (
            {"teams": [], "trace_id": "bad"},
            {"teams": [], "extra": True},
            {"teams": "bad"},
            {"teams": [_team(team_name=" Marketing ")]},
            {"teams": [{**_team(), "status": "stopped"}]},
            {"teams": [_team(), _team()]},
        )
        for body in invalid:
            with self.subTest(body=body):
                projected = bridge._authoritative_team_name(bridge.TeamResponse(200, body), "team_1")
            self.assertEqual(projected.status, 502)

        missing = bridge._authoritative_team_name(bridge.TeamResponse(200, {"teams": [_team("team_2")]}), "team_1")
        self.assertEqual(missing, bridge.TeamResponse(404, {"detail": "Team not found"}))

    def test_inference_projection_rejects_a_mismatch_with_the_requested_update(self) -> None:
        projected = bridge._project_inference_response(
            _inference(),
            "team_1",
            expected=("openai", "gpt-5.6-sol"),
        )
        self.assertEqual(projected.status, 502)

    def test_storage_projection_limits_errors_and_invalid_success(self) -> None:
        projected = bridge._project_storage_response(
            bridge.TeamResponse(507, {"private": "value"}),
            team_id="team_1",
            kind="upload",
        )
        self.assertEqual(projected, bridge.TeamResponse(507, {"detail": "team request failed"}))

        projected = bridge._project_storage_response(
            bridge.TeamResponse(200, {"invalid": True}),
            team_id="team_1",
            kind="list",
        )
        self.assertEqual(projected, bridge.TeamResponse(502, {"detail": "team unavailable"}))

        with self.assertRaisesRegex(bridge.TeamRequestError, "file exceeds"):
            bridge.upload_file(
                "team_1",
                "large.txt",
                "text/plain",
                b"x" * (bridge.MAX_FILE_UPLOAD_BYTES + 1),
            )


if __name__ == "__main__":
    unittest.main()
