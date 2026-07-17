"""Fast contracts for the local Admin-owned model credential boundary."""

from __future__ import annotations

import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import adminstore
import modelproviders


class ModelProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_store = adminstore.STORE_PATH
        adminstore.STORE_PATH = Path(self.temporary.name) / "admin.json"

    def tearDown(self) -> None:
        adminstore.STORE_PATH = self.previous_store
        self.temporary.cleanup()

    def test_status_masks_key_and_internal_resolver_is_backend_only(self) -> None:
        secret = "sk-test-0123456789abcdef"
        configured = modelproviders.configure("OpenAI", secret)

        self.assertEqual(configured["masked"], "••••cdef")
        self.assertNotIn(secret, json.dumps(modelproviders.status()))
        self.assertEqual(modelproviders.resolve_api_key("openai"), secret)
        self.assertEqual(stat.S_IMODE(adminstore.STORE_PATH.stat().st_mode), 0o600)

    def test_provider_removal_preserves_other_keys(self) -> None:
        modelproviders.configure("openai", "sk-openai-0123456789")
        modelproviders.configure("anthropic", "sk-ant-0123456789")

        removed = modelproviders.remove("openai")

        self.assertFalse(removed["configured"])
        self.assertIsNone(modelproviders.resolve_api_key("openai"))
        self.assertEqual(modelproviders.resolve_api_key("anthropic"), "sk-ant-0123456789")

    def test_invalid_provider_and_key_fail_closed(self) -> None:
        for provider, secret in (
            ("codex", "sk-test-0123456789"),
            ("claude-code", "sk-test-0123456789"),
            ("openai", " short "),
            ("anthropic", "line-one\nline-two-secret"),
        ):
            with self.subTest(provider=provider, secret=secret), self.assertRaises(modelproviders.ModelProviderError):
                modelproviders.configure(provider, secret)


if __name__ == "__main__":
    unittest.main()
