"""Local-only projection of staged Assistant snapshots and their localized summary (ADR-0091)."""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI, HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge, snapshots, transport

IMAGE_HASH = "c" * 64
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


def _routes(app: FastAPI) -> set[str]:
    return {route.path for route in app.routes}


class SnapshotRouteTests(unittest.TestCase):
    def test_registers_snapshot_routes_only_for_the_local_profile(self) -> None:
        local = FastAPI()
        snapshots.register(local, "local")
        self.assertTrue(
            {
                "/api/local-assistants",
                "/api/local-assistants/{image_hash}/icon",
                "/api/local-assistants/{image_hash}/summary",
                "/api/local-assistants/{image_hash}/details",
            }.issubset(_routes(local))
        )
        hosted = FastAPI()
        snapshots.register(hosted, "hosted")
        self.assertFalse({path for path in _routes(hosted) if path.startswith("/api/local-assistants")})

    def test_lists_snapshots_through_the_team_response(self) -> None:
        with mock.patch.object(
            bridge, "list_local_assistants", return_value=transport.TeamResponse(200, {"assistants": []})
        ):
            response = snapshots.local_assistants_list()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"assistants": []})


class SnapshotSummaryTests(unittest.TestCase):
    def summary(self, team_response: transport.TeamResponse, locale: str = "pt"):
        with mock.patch.object(bridge, "local_assistant_summary", return_value=team_response) as read:
            response = snapshots.local_assistant_summary(IMAGE_HASH, locale)
        read.assert_called_once_with(f"sha256:{IMAGE_HASH}", locale)
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
            {"locale": "pt", "summary": ""},
            {"locale": "pt", "summary": "Resumo.", "messages": []},
            {"locale": "pt"},
        ):
            with self.subTest(body=body), self.assertRaises(HTTPException) as caught:
                self.summary(transport.TeamResponse(200, body))
            self.assertEqual(caught.exception.status_code, 502)

    def test_passes_a_bounded_team_failure_through_with_its_retry_hint(self) -> None:
        busy = {
            "error": "Local Assistant preview capacity is busy",
            "code": "local-assistant-preview-busy",
            "retry_after_ms": 250,
            "trace_id": "b" * 32,
        }
        response = self.summary(transport.TeamResponse(503, busy))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body), busy)

    def test_refuses_an_invalid_locale_or_image_before_reaching_team(self) -> None:
        with mock.patch.object(bridge, "local_assistant_summary") as read:
            for locale in ("", "it", "PT", "pt-BR"):
                with self.subTest(locale=locale), self.assertRaises(HTTPException) as caught:
                    snapshots.local_assistant_summary(IMAGE_HASH, locale)
                self.assertEqual(caught.exception.status_code, 422)
        read.assert_not_called()
        with self.assertRaises(HTTPException) as caught:
            snapshots.local_assistant_summary("not-a-digest", "pt")
        self.assertEqual(caught.exception.status_code, 400)


class SnapshotDetailsTests(unittest.TestCase):
    def details(self, team_response: transport.TeamResponse, locale: str = "pt"):
        with mock.patch.object(bridge, "local_assistant_details", return_value=team_response) as read:
            response = snapshots.local_assistant_details(IMAGE_HASH, locale)
        read.assert_called_once_with(f"sha256:{IMAGE_HASH}", locale)
        return response

    def test_returns_exactly_the_requested_locale_page_without_team_trace(self) -> None:
        response = self.details(transport.TeamResponse(200, {**DETAILS, "trace_id": "a" * 32}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), DETAILS)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_refuses_a_page_in_another_locale_or_outside_its_contract(self) -> None:
        for body in (
            {**DETAILS, "locale": "en"},
            {**DETAILS, "description": "d" * 501},
            {**DETAILS, "links": {"github": "https://gitlab.com/shimpz"}},
            {**DETAILS, "actions": [{"id": "list-zones", "effect": "deleting", "description": "Liste."}]},
            {**DETAILS, "pack": {}},
        ):
            with self.subTest(body=body), self.assertRaises(HTTPException) as caught:
                self.details(transport.TeamResponse(200, body))
            self.assertEqual(caught.exception.status_code, 502)
            self.assertEqual(caught.exception.detail, "Local Assistant details is invalid")

    def test_passes_a_busy_or_refused_preview_through(self) -> None:
        for status, body in (
            (
                503,
                {"error": "busy", "code": "local-assistant-preview-busy", "retry_after_ms": 250, "trace_id": "b" * 32},
            ),
            (409, {"error": "invalid", "code": "local-assistant-preview-invalid", "trace_id": "b" * 32}),
        ):
            with self.subTest(status=status):
                response = self.details(transport.TeamResponse(status, body))
                self.assertEqual(response.status_code, status)
                self.assertEqual(json.loads(response.body), body)

    def test_refuses_an_invalid_locale_or_image_before_reaching_team(self) -> None:
        with mock.patch.object(bridge, "local_assistant_details") as read:
            for locale in ("", "it", "PT"):
                with self.subTest(locale=locale), self.assertRaises(HTTPException) as caught:
                    snapshots.local_assistant_details(IMAGE_HASH, locale)
                self.assertEqual(caught.exception.status_code, 422)
        read.assert_not_called()
        with self.assertRaises(HTTPException) as caught:
            snapshots.local_assistant_details("not-a-digest", "pt")
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
