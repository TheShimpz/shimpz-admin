"""The Supervisor's acknowledgement of one file from the web, and the download refusal asking for it (ADR-0117 §7)."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge, transport
from team import files as team_files

FILE_ID = "f" * 32


class FileAcknowledgementTests(unittest.TestCase):
    def test_an_acknowledgement_reaches_team_as_the_supervisor_and_answers_exactly_its_file(self) -> None:
        acknowledged = transport.TeamResponse(200, {"file_id": FILE_ID, "acknowledged": True})
        with mock.patch.object(transport, "call", return_value=acknowledged) as call:
            response = asyncio.run(team_files.team_file_acknowledgement("team_1", FILE_ID))
        call.assert_called_once_with("POST", f"/v1/teams/team_1/files/{FILE_ID}/acknowledgement")
        self.assertEqual((response.status_code, json.loads(response.body)), (200, acknowledged.body))

    def test_only_the_closed_refusals_pass_and_anything_else_is_team_unavailable(self) -> None:
        cases = (
            ((403, {"code": "file-acknowledgement-required", "error": "x"}), (403, "file-acknowledgement-required")),
            ((404, {"code": "file-not-found"}), (404, "file-not-found")),
            ((409, {"code": "file-not-from-web"}), (409, "file-not-from-web")),
            ((403, {"code": "invalid-supervisor"}), (502, None)),
            ((200, {"file_id": "e" * 32, "acknowledged": True}), (502, None)),
            ((200, {"file_id": FILE_ID, "acknowledged": False}), (502, None)),
        )
        for (status, body), (expected, code) in cases:
            with (
                self.subTest(status=status, body=body),
                mock.patch.object(transport, "call", return_value=transport.TeamResponse(status, body)),
            ):
                answer = bridge.acknowledge_file("team_1", FILE_ID)
            self.assertEqual((answer.status, answer.body.get("code")), (expected, code))
        with mock.patch.object(transport, "call") as call, self.assertRaises(transport.TeamRequestError):
            bridge.acknowledge_file("team_1", "not-a-file")
        call.assert_not_called()

    def test_a_download_of_an_unacknowledged_web_file_keeps_its_closed_refusal(self) -> None:
        refusal = transport.TeamAssetResponse(403, None, {"code": "file-acknowledgement-required"})
        with mock.patch.object(transport, "call_content", return_value=refusal):
            answer = bridge.file_content("team_1", FILE_ID)
        self.assertEqual(
            (answer.status, answer.error),
            (403, {"detail": "file download unavailable", "code": "file-acknowledgement-required"}),
        )


if __name__ == "__main__":
    unittest.main()
