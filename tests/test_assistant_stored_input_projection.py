"""Closed Admin projection of Team-owned Assistant Stored Input metadata."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from action import stored_input


class AssistantStoredInputProjectionTest(unittest.TestCase):
    def test_projects_only_bounded_metadata_and_exact_clear_route(self) -> None:
        metadata = {
            "assistant_id": "whatsapp",
            "stored_input_id": "whatsapp-token",
            "status": "stored",
        }
        inventory = stored_input.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "stored_inputs": [metadata],
                "trace_id": "f" * 32,
            },
        )
        with mock.patch.object(stored_input.transport, "_call", return_value=inventory) as call:
            listed = stored_input.list_assistant_stored_inputs("team_1")

        self.assertEqual(listed, stored_input.TeamResponse(200, {"stored_inputs": [metadata]}))
        call.assert_called_once_with("GET", "/v1/teams/team_1/assistant-stored-inputs")
        self.assertNotRegex(json.dumps(listed.body), r'"value"|"generation"')

        cleared_response = stored_input.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "assistant_id": "whatsapp",
                "stored_input_id": "whatsapp-token",
                "cleared": True,
                "trace_id": "e" * 32,
            },
        )
        with mock.patch.object(stored_input.transport, "_call", return_value=cleared_response) as call:
            cleared = stored_input.clear_assistant_stored_input(
                "team_1",
                "whatsapp",
                "whatsapp-token",
            )

        self.assertEqual(cleared, stored_input.TeamResponse(200, {"cleared": True}))
        call.assert_called_once_with(
            "DELETE",
            "/v1/teams/team_1/assistant-stored-inputs/whatsapp/whatsapp-token",
        )

        invalid = stored_input._project_inventory(
            stored_input.TeamResponse(
                200,
                {
                    "team_id": "team_1",
                    "stored_inputs": [{**metadata, "value": "must-not-cross"}],
                    "trace_id": "f" * 32,
                },
            ),
            "team_1",
        )
        self.assertEqual(
            invalid,
            stored_input.TeamResponse(502, {"detail": "Assistant Stored Input inventory is invalid."}),
        )


if __name__ == "__main__":
    unittest.main()
