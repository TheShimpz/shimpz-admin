from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import adminstore


class AdminStoreCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.previous_path = adminstore.STORE_PATH
        adminstore.STORE_PATH = Path(self.temporary.name) / "admin.json"
        self.addCleanup(setattr, adminstore, "STORE_PATH", self.previous_path)
        with adminstore._STORE_LOCK:
            adminstore._store_cache = None

    def test_validated_store_is_read_once_until_file_identity_changes(self) -> None:
        adminstore._write({"password_hash": "first", "session_secret": "session"})
        with adminstore._STORE_LOCK:
            adminstore._store_cache = None

        with mock.patch.object(
            adminstore,
            "_read_store_file",
            wraps=adminstore._read_store_file,
        ) as read_store:
            first = adminstore.get()
            first["password_hash"] = "caller-mutation"
            self.assertTrue(adminstore.is_initialized())
            self.assertEqual(adminstore.get()["password_hash"], "first")
            self.assertEqual(read_store.call_count, 1)

            adminstore.STORE_PATH.write_text(
                '{"password_hash":"rotated-value","session_secret":"session"}',
                encoding="utf-8",
            )
            self.assertEqual(adminstore.get()["password_hash"], "rotated-value")

        self.assertEqual(read_store.call_count, 2)

    def test_atomic_write_refreshes_cache_without_a_followup_read(self) -> None:
        with mock.patch.object(
            adminstore,
            "_read_store_file",
            wraps=adminstore._read_store_file,
        ) as read_store:
            adminstore._write({"password_hash": "written"})
            self.assertEqual(adminstore.get(), {"password_hash": "written"})

        read_store.assert_not_called()


if __name__ == "__main__":
    unittest.main()
