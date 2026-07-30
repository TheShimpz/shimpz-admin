from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state


class AdminStoreCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.previous_path = state.STORE_PATH
        state.STORE_PATH = Path(self.temporary.name) / "admin.json"
        self.addCleanup(setattr, state, "STORE_PATH", self.previous_path)
        with state._STORE_LOCK:
            state._store_cache = None

    def test_validated_store_is_read_once_until_file_identity_changes(self) -> None:
        state._write({"password_hash": "first", "session_secret": "session"})
        with state._STORE_LOCK:
            state._store_cache = None

        with mock.patch.object(
            state,
            "_read_store_file",
            wraps=state._read_store_file,
        ) as read_store:
            first = state.get()
            first["password_hash"] = "caller-mutation"
            self.assertTrue(state.is_initialized())
            self.assertEqual(state.get()["password_hash"], "first")
            self.assertEqual(read_store.call_count, 1)

            state.STORE_PATH.write_text(
                '{"password_hash":"rotated-value","session_secret":"session"}',
                encoding="utf-8",
            )
            self.assertEqual(state.get()["password_hash"], "rotated-value")

        self.assertEqual(read_store.call_count, 2)

    def test_atomic_write_refreshes_cache_without_a_followup_read(self) -> None:
        with mock.patch.object(
            state,
            "_read_store_file",
            wraps=state._read_store_file,
        ) as read_store:
            state._write({"password_hash": "written"})
            self.assertEqual(state.get(), {"password_hash": "written"})

        read_store.assert_not_called()


if __name__ == "__main__":
    unittest.main()
