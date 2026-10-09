"""Security contracts for the Admin SPA file boundary."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import LOOPBACK, asgi_exchange

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class SpaFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = app_import.temporary_root(cls)
        cls.ui_dir = cls.root / "ui"
        cls.ui_dir.mkdir()
        (cls.ui_dir / "index.html").write_bytes(b"spa shell")
        (cls.ui_dir / "asset.txt").write_bytes(b"public asset")
        cls.external_file = cls.root / "admin-secret.json"
        cls.external_file.write_bytes(b"secret sentinel")
        (cls.ui_dir / "escape.txt").symlink_to(cls.external_file)
        sibling = cls.root / "ui-sibling"
        sibling.mkdir()
        (sibling / "secret.txt").write_bytes(b"secret sentinel")

        # Register the production SPA route even in a clean source checkout, where the
        # frontend build directory is intentionally absent until the image build.
        cls.admin_app = app_import.load_app(cls.root, mock.patch.object(Path, "is_dir", return_value=True))

    async def _request(self, path: str) -> tuple[int, bytes]:
        with mock.patch.object(self.admin_app, "UI_DIR", self.ui_dir):
            exchange = await asgi_exchange(self.admin_app.app, path, LOOPBACK, unquote_path=True)
        return exchange.status, exchange.body

    def test_absolute_and_traversal_paths_never_escape_ui_directory(self) -> None:
        paths = (
            "//data/admin.json",
            "//run/shimpz-team/token",
            "//repo/.env",
            "/../../etc/passwd",
            f"/{self.external_file}",
            f"/{self.ui_dir / 'asset.txt'}",
            "/escape.txt",
            "/../ui-sibling/secret.txt",
            "/%2e%2e/ui-sibling/secret.txt",
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
