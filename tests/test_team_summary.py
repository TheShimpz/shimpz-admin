"""An installed Assistant's summary reaches the browser only in the requested interface language (ADR-0091)."""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge, summary, transport


class InstalledSummaryTests(unittest.TestCase):
    def summary(self, team_response: transport.TeamResponse, locale: str = "pt"):
        with mock.patch.object(bridge, "assistant_summary", return_value=team_response) as read:
            response = summary.assistant_summary("team_1", "shimpz-cloudflare", locale)
        read.assert_called_once_with("team_1", "shimpz-cloudflare", locale)
        return response

    def test_returns_exactly_the_requested_locale_summary_without_team_trace(self) -> None:
        response = self.summary(
            transport.TeamResponse(200, {"locale": "pt", "summary": "Resumo.", "trace_id": "a" * 32})
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"locale": "pt", "summary": "Resumo."})
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_refuses_an_answer_in_another_locale_or_outside_its_shape(self) -> None:
        for body in (
            {"locale": "en", "summary": "Summary."},
            {"locale": "pt", "summary": " Resumo."},
            {"locale": "pt", "summary": "Resumo.", "pack": {}},
        ):
            with self.subTest(body=body), self.assertRaises(HTTPException) as caught:
                self.summary(transport.TeamResponse(200, body))
            self.assertEqual(caught.exception.status_code, 502)
            self.assertEqual(caught.exception.detail, "Assistant summary is invalid")

    def test_passes_a_bounded_team_failure_through(self) -> None:
        absent = {"error": "Assistant is not installed in this Team", "code": "assistant-not-installed"}
        response = self.summary(transport.TeamResponse(404, absent))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(json.loads(response.body), absent)

    def test_refuses_an_invalid_locale_team_or_assistant_before_reaching_team(self) -> None:
        with mock.patch.object(bridge, "assistant_summary") as read:
            for locale in ("", "it", "PT", "pt-BR"):
                with self.subTest(locale=locale), self.assertRaises(HTTPException) as caught:
                    summary.assistant_summary("team_1", "shimpz-cloudflare", locale)
                self.assertEqual(caught.exception.status_code, 422)
        read.assert_not_called()
        for team_id, assistant_id in (("Team 1", "shimpz-cloudflare"), ("team_1", "../icon")):
            with self.subTest(team_id=team_id, assistant_id=assistant_id), self.assertRaises(HTTPException) as caught:
                summary.assistant_summary(team_id, assistant_id, "pt")
            self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
