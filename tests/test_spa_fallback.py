"""Security contracts for the Admin SPA file boundary."""

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


class SpaFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        cls.root = Path(cls.tempdir.name)
        cls.ui_dir = cls.root / "ui"
        cls.ui_dir.mkdir()
        (cls.ui_dir / "index.html").write_bytes(b"spa shell")
        (cls.ui_dir / "asset.txt").write_bytes(b"public asset")
        cls.external_file = cls.root / "admin-secret.json"
        cls.external_file.write_bytes(b"secret sentinel")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "SHIMPZ_REPO": str(cls.root),
                    "SHIMPZ_ADMIN_STORE": str(cls.root / "admin.json"),
                },
            ),
            mock.patch.object(Path, "is_dir", return_value=True),
        ):
            # Register the production SPA route even in a clean source checkout, where the
            # frontend build directory is intentionally absent until the image build.
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    async def _request(self, path: str) -> tuple[int, bytes]:
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
        with mock.patch.object(self.admin_app, "UI_DIR", self.ui_dir):
            await self.admin_app.app(scope, receive, send)

        status = next(message["status"] for message in messages if message["type"] == "http.response.start")
        body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        return status, body

    def test_absolute_and_traversal_paths_never_escape_ui_directory(self) -> None:
        paths = (
            "//data/admin.json",
            "//run/shimpz-teamdriver/token",
            "//repo/.env",
            "/../../etc/passwd",
            f"/{self.external_file}",
        )

        for path in paths:
            with self.subTest(path=path):
                status, body = asyncio.run(self._request(path))
                self.assertEqual(status, 200)
                self.assertEqual(body, b"spa shell")
                self.assertNotIn(b"secret sentinel", body)

    def test_asset_inside_ui_directory_is_served(self) -> None:
        status, body = asyncio.run(self._request("/asset.txt"))

        self.assertEqual(status, 200)
        self.assertEqual(body, b"public asset")


if __name__ == "__main__":
    unittest.main()
