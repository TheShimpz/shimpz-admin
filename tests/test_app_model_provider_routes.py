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
                ("/api/capsules/{cid}/inference", "GET"),
                ("/api/capsules/{cid}/inference", "PUT"),
            }.issubset(routes)
        )
        websocket_paths = {
            route.path for route in self.admin_app.app.routes if route.__class__.__name__ == "APIWebSocketRoute"
        }
        self.assertIn("/api/capsules/{cid}/chat/ws", websocket_paths)
        self.assertNotIn(("/api/capsules/{cid}/chat", "POST"), routes)
        self.assertNotIn(("/api/capsules/{cid}/chat/stop", "POST"), routes)
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


if __name__ == "__main__":
    unittest.main()
