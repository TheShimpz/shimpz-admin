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


PAGE = {
    "locale": "ja",
    "assistant_id": "shimpz-cloudflare",
    "assistant_version": "1.4.0",
    "name": "Shimpz Cloudflare",
    "creators": ["@shimpz", "@Shimpz-Team"],
    "summary": "DNS の変更を安全に公開します。",
    "description": "Cloudflare のゾーンを確認し、承認後にだけレコードを公開します。",
    "links": {},
    "actions": [{"id": "list-zones", "effect": "read_only", "description": "ゾーンを一覧表示します。"}],
    "integrations": [],
    "stored_inputs": [
        {
            "id": "api-token",
            "label": "API トークン",
            "description": "Cloudflare のダッシュボードで API トークンを作成してコピーします。",
            "help_url": "https://dash.cloudflare.com/profile/api-tokens",
        }
    ],
}


class InstalledDetailsTests(unittest.TestCase):
    def details(self, team_response: transport.TeamResponse, assistant_id: str = "shimpz-cloudflare"):
        with mock.patch.object(bridge, "assistant_details", return_value=team_response) as read:
            response = summary.assistant_details("team_1", assistant_id, "ja")
        read.assert_called_once_with("team_1", assistant_id, "ja")
        return response

    def test_returns_the_exact_binding_page_in_the_requested_locale(self) -> None:
        response = self.details(transport.TeamResponse(200, {**PAGE, "trace_id": "a" * 32}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), PAGE)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_refuses_another_assistant_locale_or_shape(self) -> None:
        for body, assistant_id in (
            (PAGE, "other-assistant"),
            ({**PAGE, "locale": "en"}, "shimpz-cloudflare"),
            ({**PAGE, "creators": []}, "shimpz-cloudflare"),
        ):
            with self.subTest(body=body, assistant_id=assistant_id), self.assertRaises(HTTPException) as caught:
                self.details(transport.TeamResponse(200, body), assistant_id)
            self.assertEqual(caught.exception.status_code, 502)

    def test_passes_a_bounded_team_failure_through(self) -> None:
        invalid = {"error": "Assistant needs replacement", "code": "assistant-manifest-invalid"}
        response = self.details(transport.TeamResponse(409, invalid))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body), invalid)


if __name__ == "__main__":
    unittest.main()
