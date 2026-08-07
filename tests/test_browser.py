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
    def test_missing_spa_uses_no_inline_script_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            policy = browser.security_headers(Path(directory))["Content-Security-Policy"]

        script_directive = next(part.strip() for part in policy.split(";") if part.strip().startswith("script-src"))
        self.assertEqual(script_directive, "script-src 'self'")

    def test_inline_bootstrap_is_bound_by_hash_without_unsafe_script(self) -> None:
        bootstrap = "console.log('compiled bootstrap')"
        digest = base64.b64encode(hashlib.sha256(bootstrap.encode()).digest()).decode()
        with tempfile.TemporaryDirectory() as directory:
            ui_dir = Path(directory)
            (ui_dir / "index.html").write_text(
                f'<p>compiled shell</p><script src="/external.js"></script><script>{bootstrap}</script>',
                encoding="utf-8",
            )
            policy = browser.security_headers(ui_dir)["Content-Security-Policy"]

        script_directive = next(part.strip() for part in policy.split(";") if part.strip().startswith("script-src"))
        self.assertIn(f"'sha256-{digest}'", script_directive)
        self.assertNotIn("'unsafe-inline'", script_directive)
        self.assertIn("style-src 'self' 'unsafe-inline'", policy)

    def test_oauth_redirect_rejects_unknown_failure_values(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "invalid OAuth redirect failure"):
            browser.oauth_chat_redirect(
                "unexpected",
                cookie_name="binding",
                cookie_path="/api/oauth",
            )


if __name__ == "__main__":
    unittest.main()
