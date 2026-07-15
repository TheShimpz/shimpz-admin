"""Route-level contracts for the Admin's session-gated Driver credential proxy."""

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


class DriverRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    def test_exposes_exact_generic_driver_routes(self):
        routes = {(route.path, method) for route in self.admin_app.app.routes for method in (route.methods or set())}
        expected = {
            ("/api/capsules/{cid}/drivers/{driver_id}", "GET"),
            ("/api/capsules/{cid}/drivers/{driver_id}/credentials", "POST"),
            ("/api/capsules/{cid}/drivers/{driver_id}/credentials/{credential_id}", "PUT"),
            ("/api/capsules/{cid}/drivers/{driver_id}/credentials/{credential_id}", "DELETE"),
            ("/api/capsules/{cid}/drivers/{driver_id}/credentials/{credential_id}/verify", "POST"),
        }
        self.assertTrue(expected.issubset(routes))

    def test_driver_routes_are_not_in_open_api_and_reject_anonymous_requests(self):
        concrete_path = "/api/capsules/capsule_1/drivers/cloudflare-r2"
        self.assertNotIn(concrete_path, self.admin_app.OPEN_API)
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": concrete_path,
            "raw_path": concrete_path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def should_not_run(_request):
            self.fail("unauthenticated request reached the Driver route")

        response = asyncio.run(self.admin_app._gate(Request(scope, receive), should_not_run))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.body, b'{"detail":"unauthenticated"}')


if __name__ == "__main__":
    unittest.main()
