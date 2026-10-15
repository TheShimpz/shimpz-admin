"""Local-only staged Assistant snapshots and their localized summary and page, as session calls (ADR-0091)."""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge, snapshots, transport

IMAGE_ID = "sha256:" + "c" * 64
# One staged snapshot's page as Team answers it: Team HTTP protocol `assistant_details`.
DETAILS = {
    "locale": "pt",
    "assistant_id": "shimpz-cloudflare",
    "assistant_version": "1.4.0",
    "name": "Shimpz Cloudflare",
    "creators": ["@shimpz"],
    "summary": "Publica alterações de DNS com segurança.",
    "description": "Navegue pelas suas zonas e publique registros só depois da sua aprovação.",
    "links": {"github": "https://github.com/TheShimpz"},
    "actions": [{"id": "list-zones", "effect": "read_only", "description": "Liste suas zonas."}],
    "integrations": [{"id": "cloudflare", "provider": "cloudflare"}],
    "stored_inputs": [],
}


class SnapshotListTests(unittest.TestCase):
    def test_lists_snapshots_through_the_team_response(self) -> None:
        with mock.patch.object(
            bridge, "list_local_assistants", return_value=transport.TeamResponse(200, {"assistants": []})
        ):
            response = snapshots.local_assistants_list()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"assistants": []})


class SnapshotPreviewTests(unittest.TestCase):
    """Each staged snapshot's summary and page reads the exact image through the shared localized projection."""

    def test_reads_the_exact_image_in_the_requested_locale_without_team_trace(self) -> None:
        for read, call, answer in (
            ("local_assistant_summary", snapshots.local_assistant_summary, {"locale": "pt", "summary": "Resumo."}),
            ("local_assistant_details", snapshots.local_assistant_details, DETAILS),
        ):
            team_response = transport.TeamResponse(200, {**answer, "trace_id": "a" * 32})
            with self.subTest(read=read), mock.patch.object(bridge, read, return_value=team_response) as reader:
                response = call(IMAGE_ID, "pt")
            reader.assert_called_once_with(IMAGE_ID, "pt")
            self.assertEqual(json.loads(response.body), answer)

    def test_names_a_refused_page_as_the_local_assistant_and_refuses_an_invalid_image(self) -> None:
        refused = transport.TeamResponse(200, {**DETAILS, "locale": "en"})
        with (
            mock.patch.object(bridge, "local_assistant_details", return_value=refused),
            self.assertRaises(HTTPException) as caught,
        ):
            snapshots.local_assistant_details(IMAGE_ID, "pt")
        self.assertEqual(caught.exception.detail, "Local Assistant details is invalid")
        for call in (snapshots.local_assistant_summary, snapshots.local_assistant_details):
            with self.subTest(call=call.__name__), self.assertRaises(HTTPException) as caught:
                call("not-a-digest", "pt")
            self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
