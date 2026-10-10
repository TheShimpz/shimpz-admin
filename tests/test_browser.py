"""Unit contracts for the compiled Admin browser policy."""

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
            policy = browser.security_headers(browser.spa_script_sources(Path(directory)), frozenset())[
                "Content-Security-Policy"
            ]

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
            policy = browser.security_headers(browser.spa_script_sources(ui_dir), frozenset())[
                "Content-Security-Policy"
            ]

        script_directive = next(part.strip() for part in policy.split(";") if part.strip().startswith("script-src"))
        self.assertIn(f"'sha256-{digest}'", script_directive)
        self.assertNotIn("'unsafe-inline'", script_directive)
        self.assertIn("style-src 'self' 'unsafe-inline'", policy)
        self.assertIn("img-src 'self' data: blob:", policy)

    def test_sockets_may_reach_only_the_admitted_admin_origins_and_nothing_is_framed(self) -> None:
        admitted = frozenset({"http://127.0.0.1:7777", "http://localhost:7777", "https://admin.example.test"})
        policy = browser.security_headers((), admitted)["Content-Security-Policy"]
        directives = {part.strip().split(" ", 1)[0]: part.strip() for part in policy.split(";")}

        self.assertEqual(
            directives["connect-src"],
            "connect-src 'self' ws://127.0.0.1:7777 ws://localhost:7777 wss://admin.example.test",
        )
        self.assertEqual(directives["frame-src"], "frame-src 'none'")

    def test_oauth_redirect_rejects_unknown_failure_values(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "invalid OAuth redirect failure"):
            browser.oauth_chat_redirect(
                "unexpected",
                cookie_name="binding",
                cookie_path="/api/oauth",
            )


if __name__ == "__main__":
    unittest.main()
