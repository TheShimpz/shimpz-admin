"""Browser security-header contracts for every Admin response class."""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        cls.ui_dir = root / "ui"
        cls.ui_dir.mkdir()
        (cls.ui_dir / "index.html").write_bytes(b"spa shell")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "SHIMPZ_REPO": str(root),
                    "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                    "SHIMPZ_ADMIN_PROFILE": "local",
                },
            ),
            mock.patch.object(Path, "is_dir", return_value=True),
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    async def _request(self, method: str, path: str) -> tuple[int, dict[str, str]]:
        messages: list[dict] = []
        request_sent = False

        async def receive() -> dict:
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("local.shimpz.com", 443),
        }
        with mock.patch.object(self.admin_app, "UI_DIR", self.ui_dir):
            await self.admin_app.app(scope, receive, send)

        start = next(message for message in messages if message["type"] == "http.response.start")
        headers = {key.decode().lower(): value.decode() for key, value in start["headers"]}
        return start["status"], headers

    def assert_security_headers(self, headers: dict[str, str]) -> None:
        policy = headers["content-security-policy"]
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertIn("frame-src https://shimpz.com", policy)
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["referrer-policy"], "no-referrer")
        self.assertIn("camera=()", headers["permissions-policy"])

    def test_spa_open_api_and_unauthorized_api_are_hardened(self) -> None:
        for method, path, expected_status in (
            ("GET", "/", 200),
            ("POST", "/api/session", 200),
            ("GET", "/api/model-providers", 401),
        ):
            with self.subTest(path=path):
                status, headers = asyncio.run(self._request(method, path))
                self.assertEqual(status, expected_status)
                self.assert_security_headers(headers)

    def test_identity_failure_is_hardened(self) -> None:
        unavailable = self.admin_app.SessionEvidenceUnavailableError("unavailable")
        with mock.patch.object(self.admin_app, "_session_evidence", side_effect=unavailable):
            status, headers = asyncio.run(self._request("GET", "/api/model-providers"))

        self.assertEqual(status, 503)
        self.assert_security_headers(headers)


if __name__ == "__main__":
    unittest.main()
