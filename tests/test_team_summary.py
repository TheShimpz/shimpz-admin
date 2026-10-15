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

SUMMARY = {"locale": "pt", "summary": "Resumo."}
# One page as Team answers it: the first valid `assistant_details` vector of Team's HTTP protocol.
DETAILS = json.loads((ROOT / "backend/protocol/http/v1/vectors.json").read_text())["assistant_details"]["valid"][0]
ANSWERS = {"summary": SUMMARY, "details": DETAILS}
REFUSED = {
    "summary": (
        {"locale": "en", "summary": "Summary."},
        {"locale": "pt", "summary": ""},
        {"locale": "pt", "summary": " Resumo."},
        {"locale": "pt", "summary": "Resumo.", "pack": {}},
        {"locale": "pt"},
    ),
    "details": (
        {**DETAILS, "locale": "en"},
        {**DETAILS, "description": "d" * 501},
        {**DETAILS, "links": {"github": "https://gitlab.com/shimpz"}},
        {**DETAILS, "actions": [{"id": "list-zones", "effect": "deleting", "description": "Liste."}]},
        {**DETAILS, "creators": []},
        {**DETAILS, "pack": {}},
    ),
}


class LocalizedTests(unittest.TestCase):
    """The one projection every Assistant summary and page passes through, for both kinds."""

    def localized(self, kind: str, team_response: transport.TeamResponse, locale: str = "pt"):
        read = mock.Mock(return_value=team_response)
        response = summary.localized(read, locale, "Assistant", kind=kind)
        read.assert_called_once_with(locale)
        return response

    def test_returns_exactly_the_requested_locale_answer_without_team_trace(self) -> None:
        for kind, answer in ANSWERS.items():
            with self.subTest(kind=kind):
                response = self.localized(kind, transport.TeamResponse(200, {**answer, "trace_id": "a" * 32}))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(json.loads(response.body), answer)

    def test_refuses_an_answer_in_another_locale_or_outside_its_shape(self) -> None:
        for kind, bodies in REFUSED.items():
            for body in bodies:
                with self.subTest(kind=kind, body=body), self.assertRaises(HTTPException) as caught:
                    self.localized(kind, transport.TeamResponse(200, body))
                self.assertEqual(caught.exception.status_code, 502)
                self.assertEqual(caught.exception.detail, f"Assistant {kind} is invalid")

    def test_passes_a_bounded_team_failure_through_with_its_retry_hint(self) -> None:
        for status, body in (
            (
                503,
                {"error": "busy", "code": "local-assistant-preview-busy", "retry_after_ms": 250, "trace_id": "b" * 32},
            ),
            (409, {"error": "invalid", "code": "local-assistant-preview-invalid", "trace_id": "b" * 32}),
            (404, {"error": "Assistant is not installed in this Team", "code": "assistant-not-installed"}),
        ):
            for kind in ANSWERS:
                with self.subTest(kind=kind, status=status):
                    response = self.localized(kind, transport.TeamResponse(status, body))
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(json.loads(response.body), body)

    def test_refuses_an_invalid_locale_before_reading_and_a_refused_request_as_bad(self) -> None:
        read = mock.Mock()
        for kind in ANSWERS:
            for locale in ("", "it", "PT", "pt-BR"):
                with self.subTest(kind=kind, locale=locale), self.assertRaises(HTTPException) as caught:
                    summary.localized(read, locale, "Assistant", kind=kind)
                self.assertEqual(caught.exception.status_code, 422)
        read.assert_not_called()
        refused = mock.Mock(side_effect=transport.TeamRequestError("assistant id is invalid"))
        with self.assertRaises(HTTPException) as caught:
            summary.localized(refused, "pt", "Assistant")
        self.assertEqual(caught.exception.status_code, 400)


class InstalledSummaryTests(unittest.TestCase):
    def test_reads_the_installed_binding_summary_in_the_requested_locale(self) -> None:
        answer = transport.TeamResponse(200, {**SUMMARY, "trace_id": "a" * 32})
        with mock.patch.object(bridge, "assistant_summary", return_value=answer) as read:
            response = summary.assistant_summary("team_1", "shimpz-cloudflare", "pt")
        read.assert_called_once_with("team_1", "shimpz-cloudflare", "pt")
        self.assertEqual(json.loads(response.body), SUMMARY)

    def test_refuses_an_invalid_team_or_assistant_before_reaching_team(self) -> None:
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

    def test_refuses_the_page_of_another_assistant(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            self.details(transport.TeamResponse(200, PAGE), "other-assistant")
        self.assertEqual(caught.exception.status_code, 502)

    def test_passes_a_bounded_team_failure_through(self) -> None:
        invalid = {
            "error": "installed Assistant manifest failed its reviewed contract",
            "code": "assistant-manifest-invalid",
        }
        response = self.details(transport.TeamResponse(409, invalid))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body), invalid)


if __name__ == "__main__":
    unittest.main()
