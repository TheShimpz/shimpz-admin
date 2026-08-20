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
            self.assertEqual(bridge.create("team_1", " Marketing "), expected)
            self.assertEqual(bridge.stop_chat("team_1"), expected)
            self.assertEqual(bridge.pending_chat_integrations("team_1"), expected)
            self.assertEqual(bridge.pending_chat_human("team_1"), expected)
        self.assertEqual(
            call.call_args_list,
            [
                mock.call("POST", "/v1/teams/team_1/create", {"team_name": "Marketing"}),
                mock.call("POST", "/v1/teams/team_1/chat/stop", {}),
                mock.call("GET", "/v1/teams/team_1/chat/integrations"),
                mock.call("GET", "/v1/teams/team_1/chat/human"),
            ],
        )
        with self.assertRaisesRegex(bridge.TeamRequestError, "team name"):
            bridge.create("team_1", " ")

    def test_space_reset_projects_only_the_admin_confirmation(self) -> None:
        response = bridge.TeamResponse(
            200,
            {
                "reset": True,
                "assistants_removed": 1,
                "teams_removed": 2,
                "storage_removed": True,
                "residue_absent": ["assistant_containers", "team_storage"],
            },
        )
        with mock.patch.object(bridge, "_call", return_value=response) as call:
            projected = bridge.reset_space()
        self.assertEqual(projected, bridge.TeamResponse(200, {"reset": True}))
        call.assert_called_once_with("DELETE", "/v1/space")

        response = bridge.TeamResponse(200, {"reset": True, "producer_metadata": {"version": 2}})
        with mock.patch.object(bridge, "_call", return_value=response):
            self.assertEqual(bridge.reset_space(), bridge.TeamResponse(200, {"reset": True}))

    def test_space_reset_rejects_invalid_success_and_preserves_failures(self) -> None:
        for body in ({}, {"reset": False}, {"reset": 1}, [], "reset", None):
            with (
                self.subTest(body=body),
                mock.patch.object(
                    bridge,
                    "_call",
                    return_value=bridge.TeamResponse(200, body),
                ),
            ):
                self.assertEqual(
                    bridge.reset_space(),
                    bridge.TeamResponse(502, {"detail": "Team returned an invalid Space reset response"}),
                )

        for response in (
            bridge.TeamResponse(500, {"detail": "incomplete", "code": "teardown-incomplete"}),
            bridge.TeamResponse(503, {"detail": "unavailable", "code": "docker-reset-failed"}),
        ):
            with self.subTest(status=response.status), mock.patch.object(bridge, "_call", return_value=response):
                self.assertEqual(bridge.reset_space(), response)

    def test_bootstrap_reset_reauthors_team_failures_and_projects_success(self) -> None:
        success = bridge.TeamResponse(200, {"reset": True, "residue_absent": ["teams"]})
        with mock.patch.object(bridge, "_call", return_value=success) as call:
            self.assertEqual(bridge.bootstrap_reset_space(), bridge.TeamResponse(200, {"reset": True}))
        call.assert_called_once_with("DELETE", "/v1/space/bootstrap")

        cases = (
            (
                bridge.TeamResponse(409, {"code": "supervisor-established", "detail": "internal"}),
                409,
                "bootstrap-reset-refused",
            ),
            (
                bridge.TeamResponse(503, {"code": "supervisor-unavailable", "detail": "internal"}),
                503,
                "bootstrap-reset-unavailable",
            ),
            (
                bridge.TeamResponse(200, {"reset": False}),
                502,
                "bootstrap-reset-unavailable",
            ),
        )
        for response, status, code in cases:
            with self.subTest(status=response.status), mock.patch.object(bridge, "_call", return_value=response):
                projected = bridge.bootstrap_reset_space()
            self.assertEqual(projected.status, status)
            self.assertEqual(projected.body["code"], code)
            self.assertIn("nothing was deleted", projected.body["detail"])
            self.assertNotIn(response.body.get("code"), projected.body.values())

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
