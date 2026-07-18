"""Route-level security contracts for local model API keys."""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class ModelProviderRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {"SHIMPZ_REPO": str(root), "SHIMPZ_ADMIN_STORE": str(root / "admin.json")},
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    def test_exposes_only_masked_credential_management_routes(self) -> None:
        routes = {
            (route.path, method)
            for route in self.admin_app.app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        self.assertTrue(
            {
                ("/api/model-providers", "GET"),
                ("/api/model-providers/{provider}", "PUT"),
                ("/api/model-providers/{provider}", "DELETE"),
                ("/api/teams/{team_id}/inference", "GET"),
                ("/api/teams/{team_id}/inference", "PUT"),
            }.issubset(routes)
        )
        websocket_paths = {
            route.path for route in self.admin_app.app.routes if route.__class__.__name__ == "APIWebSocketRoute"
        }
        self.assertIn("/api/teams/{team_id}/chat/ws", websocket_paths)
        self.assertNotIn(("/api/teams/{team_id}/chat", "POST"), routes)
        self.assertNotIn(("/api/teams/{team_id}/chat/stop", "POST"), routes)
        self.assertFalse(any("resolve" in path or "secret" in path for path, _method in routes))

    def test_model_provider_routes_require_the_local_admin_session(self) -> None:
        path = "/api/model-providers"
        self.assertNotIn(path, self.admin_app.OPEN_API)
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def should_not_run(_request):
            self.fail("unauthenticated request reached the model credential route")

        response = asyncio.run(self.admin_app._gate(Request(scope, receive), should_not_run))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.body, b'{"detail":"unauthenticated"}')

    def test_configure_validates_in_a_worker_thread(self) -> None:
        secret = "sk-test-" + str(123456789).zfill(10)
        expected = {"id": "openai", "configured": True}
        with (
            mock.patch.object(
                self.admin_app,
                "_bounded_json_object",
                new=mock.AsyncMock(return_value={"api_key": secret}),
            ),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(return_value=expected)) as worker,
        ):
            response = asyncio.run(self.admin_app.model_provider_configure("openai", mock.Mock()))

        self.assertEqual(response, expected)
        worker.assert_awaited_once_with(self.admin_app.modelproviders.configure, "openai", secret)

    def test_configure_maps_rejection_and_unavailability_without_disclosing_secret(self) -> None:
        secret = "sk-test-" + str(123456789).zfill(10)
        cases = (
            (self.admin_app.modelproviders.ModelProviderError("model provider rejected API key"), 400),
            (
                self.admin_app.modelproviders.ModelProviderUnavailableError(
                    "model provider validation is temporarily unavailable"
                ),
                503,
            ),
        )
        for error, expected_status in cases:
            with (
                self.subTest(expected_status=expected_status),
                mock.patch.object(
                    self.admin_app,
                    "_bounded_json_object",
                    new=mock.AsyncMock(return_value={"api_key": secret}),
                ),
                mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(side_effect=error)),
                self.assertRaises(HTTPException) as caught,
            ):
                asyncio.run(self.admin_app.model_provider_configure("openai", mock.Mock()))

            self.assertEqual(caught.exception.status_code, expected_status)
            self.assertNotIn(secret, caught.exception.detail)

    def test_configure_rejects_a_missing_secret_before_starting_a_worker(self) -> None:
        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value={})),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock()) as worker,
            self.assertRaises(HTTPException) as caught,
        ):
            asyncio.run(self.admin_app.model_provider_configure("openai", mock.Mock()))

        self.assertEqual(caught.exception.status_code, 400)
        worker.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
