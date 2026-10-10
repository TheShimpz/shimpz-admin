"""Browser security-header contracts for every Admin response class."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import Peer, asgi_exchange

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


# A loopback browser of the Local Space's public origin.
LOCAL_ORIGIN = Peer("https", ("127.0.0.1", 1234), ("local.shimpz.com", 443))


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.ui_dir = root / "ui"
        cls.ui_dir.mkdir()
        (cls.ui_dir / "index.html").write_bytes(b"spa shell")

        cls.admin_app = app_import.load_app(root, mock.patch.object(Path, "is_dir", return_value=True))

    async def _request(self, method: str, path: str) -> tuple[int, dict[str, str]]:
        with mock.patch.object(self.admin_app, "UI_DIR", self.ui_dir):
            exchange = await asgi_exchange(self.admin_app.app, path, LOCAL_ORIGIN, method=method)
        return exchange.status, exchange.headers

    def assert_security_headers(self, headers: dict[str, str]) -> None:
        policy = headers["content-security-policy"]
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertIn("frame-src 'none'", policy)
        self.assertTrue(policy.endswith("; connect-src 'self' ws://127.0.0.1:7777 ws://localhost:7777"))
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
