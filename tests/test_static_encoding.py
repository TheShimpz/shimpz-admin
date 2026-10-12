"""Admin sends a static build file's precompressed sibling only to browsers that accept it, and encodes nothing else."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import LOOPBACK, asgi_exchange

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import browser

SCRIPT = b"export const answer = 42;\n" * 40
SHELL = b"<!doctype html><title>Shimpz Admin</title>" + b"<p>shell</p>" * 40


class StaticEncodingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.ui_dir = root / "ui"
        (cls.ui_dir / "_app").mkdir(parents=True)
        (cls.ui_dir / "index.html").write_bytes(SHELL)
        (cls.ui_dir / "index.html.br").write_bytes(b"brotli shell")
        (cls.ui_dir / "_app" / "start.js").write_bytes(SCRIPT)
        (cls.ui_dir / "_app" / "start.js.br").write_bytes(b"brotli script")
        (cls.ui_dir / "_app" / "start.js.gz").write_bytes(b"gzip script")
        # A sibling that would not save a byte is never sent.
        (cls.ui_dir / "_app" / "tiny.js").write_bytes(b"1;")
        (cls.ui_dir / "_app" / "tiny.js.br").write_bytes(b"brotli tiny")
        # A sibling that resolves outside the build is never sent.
        (root / "outside.br").write_bytes(b"outside")
        (cls.ui_dir / "_app" / "escape.js").write_bytes(SCRIPT)
        (cls.ui_dir / "_app" / "escape.js.br").symlink_to(root / "outside.br")
        cls.admin_app = app_import.load_app(root, mock.patch.object(Path, "is_dir", return_value=True))

    def _get(self, path: str, accept: str | None, method: str = "GET"):
        headers = [] if accept is None else [(b"accept-encoding", accept.encode())]
        with mock.patch.object(self.admin_app, "UI_DIR", self.ui_dir):
            return asyncio.run(asgi_exchange(self.admin_app.app, path, LOOPBACK, method=method, headers=headers))

    def assert_hardened(self, headers: dict[str, str]) -> None:
        self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["referrer-policy"], "no-referrer")

    def test_a_browser_that_accepts_brotli_gets_the_brotli_sibling_in_the_file_type(self) -> None:
        exchange = self._get("/_app/start.js", "gzip, deflate, br, zstd")

        self.assertEqual(exchange.status, 200)
        self.assertEqual(exchange.body, b"brotli script")
        self.assertEqual(exchange.headers["content-encoding"], "br")
        self.assertEqual(exchange.headers["content-type"], "text/javascript; charset=utf-8")
        self.assertEqual(exchange.headers["content-length"], str(len(b"brotli script")))
        self.assertEqual(exchange.headers["vary"], "Accept-Encoding")
        self.assert_hardened(exchange.headers)

    def test_gzip_answers_when_brotli_is_not_accepted(self) -> None:
        for accept in ("gzip", "br;q=0, GZIP;q=0.5"):
            with self.subTest(accept=accept):
                exchange = self._get("/_app/start.js", accept)
                self.assertEqual((exchange.body, exchange.headers["content-encoding"]), (b"gzip script", "gzip"))

    def test_the_file_itself_answers_without_an_accepted_coding(self) -> None:
        for accept in (None, "", "identity", "br;q=0, gzip;q=0", "br;q=zero", "zstd"):
            with self.subTest(accept=accept):
                exchange = self._get("/_app/start.js", accept)
                self.assertEqual(exchange.body, SCRIPT)
                self.assertNotIn("content-encoding", exchange.headers)
                self.assertEqual(exchange.headers["vary"], "Accept-Encoding")
                self.assert_hardened(exchange.headers)

    def test_a_sibling_that_is_not_smaller_or_leaves_the_build_is_never_sent(self) -> None:
        for path, body in (("/_app/tiny.js", b"1;"), ("/_app/escape.js", SCRIPT)):
            with self.subTest(path=path):
                exchange = self._get(path, "br")
                self.assertEqual(exchange.body, body)
                self.assertNotIn("content-encoding", exchange.headers)

    def test_the_spa_shell_is_encoded_for_a_client_route_and_a_sibling_is_never_its_own_asset(self) -> None:
        for path in ("/chat/", "/_app/start.js.br", "/_app/start.js.gz"):
            with self.subTest(path=path):
                exchange = self._get(path, "br")
                self.assertEqual(exchange.body, b"brotli shell")
                self.assertEqual(exchange.headers["content-encoding"], "br")
                self.assertEqual(exchange.headers["content-type"], "text/html; charset=utf-8")
                self.assert_hardened(exchange.headers)

    def test_api_answers_are_never_encoded(self) -> None:
        for method, path in (("POST", "/api/session"), ("GET", "/api/teams"), ("GET", "/api/unknown-endpoint")):
            with self.subTest(path=path):
                exchange = self._get(path, "br, gzip", method=method)
                self.assertTrue(exchange.headers["content-type"].startswith("application/json"))
                self.assertNotIn("content-encoding", exchange.headers)
                self.assertNotIn("Accept-Encoding", exchange.headers.get("vary", ""))
                self.assert_hardened(exchange.headers)


class AcceptedEncodingsTests(unittest.TestCase):
    def test_only_codings_named_with_a_quality_above_zero_are_accepted(self) -> None:
        cases = {
            "": frozenset(),
            " , ;q=1": frozenset(),
            "gzip, deflate, br, zstd": frozenset({"gzip", "deflate", "br", "zstd"}),
            "BR;Q=0.8, gzip;q=0": frozenset({"br"}),
            "br;level=5;q=0.1": frozenset({"br"}),
            "br;q=, gzip;q=nan": frozenset(),
        }
        for header, expected in cases.items():
            with self.subTest(header=header):
                self.assertEqual(browser.accepted_encodings(header), expected)


if __name__ == "__main__":
    unittest.main()
