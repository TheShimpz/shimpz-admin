"""Unit contracts for the compiled Admin browser policy."""

from __future__ import annotations

import base64
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import browser


class BrowserPolicyTests(unittest.TestCase):
    def test_inline_bootstrap_is_bound_by_hash_without_unsafe_script(self) -> None:
        bootstrap = "console.log('compiled bootstrap')"
        digest = base64.b64encode(hashlib.sha256(bootstrap.encode()).digest()).decode()
        with tempfile.TemporaryDirectory() as directory:
            ui_dir = Path(directory)
            (ui_dir / "index.html").write_text(
                f'<script src="/external.js"></script><script>{bootstrap}</script>',
                encoding="utf-8",
            )
            policy = browser.security_headers(ui_dir)["Content-Security-Policy"]

        self.assertIn(f"script-src 'self' 'sha256-{digest}'", policy)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", policy)
        self.assertIn("style-src 'self' 'unsafe-inline'", policy)


if __name__ == "__main__":
    unittest.main()
