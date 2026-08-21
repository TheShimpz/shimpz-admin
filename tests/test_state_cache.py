from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa_helper import configure_supervisor


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
        state._write({"session_secret": "first"})
        with state._STORE_LOCK:
            state._store_cache = None

        with mock.patch.object(
            state,
            "_read_store_file",
            wraps=state._read_store_file,
        ) as read_store:
            first = state.get()
            first["session_secret"] = "caller-mutation"
            self.assertFalse(state.is_initialized())
            self.assertEqual(state.get()["session_secret"], "first")
            self.assertEqual(read_store.call_count, 1)

            state.STORE_PATH.write_text(
                '{"session_secret":"rotated-value"}',
                encoding="utf-8",
            )
            self.assertEqual(state.get()["session_secret"], "rotated-value")

        self.assertEqual(read_store.call_count, 2)

    def test_atomic_write_refreshes_cache_without_a_followup_read(self) -> None:
        with mock.patch.object(
            state,
            "_read_store_file",
            wraps=state._read_store_file,
        ) as read_store:
            state._write({"session_secret": "written"})
            self.assertEqual(state.get(), {"session_secret": "written"})

        read_store.assert_not_called()

    def test_password_initialization_creates_one_persistent_local_supervisor(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        first = state.local_supervisor()

        self.assertRegex(first.supervisor_id, r"^[0-9a-f]{32}$")
        self.assertRegex(first.private_key_hex, r"^[0-9a-f]{64}$")
        self.assertEqual(state.local_supervisor(), first)

    def test_browser_origin_binding_preserves_a_retired_verifier_for_release_rollback(self) -> None:
        retired = {
            "salt": "00" * 32,
            "password_hash": "11" * 32,
            "session_secret": "session",
        }
        state._write(retired)

        with mock.patch.object(state, "_write", wraps=state._write) as write:
            self.assertEqual(state.bind_browser_origin("https://dev.example.test"), "learned")
            self.assertEqual(state.browser_origin(), "https://dev.example.test")
            self.assertEqual(state.bind_browser_origin("https://dev.example.test"), "unchanged")
            self.assertEqual(state.bind_browser_origin("https://next.example.test:8443"), "replaced")

        self.assertEqual(write.call_count, 2)
        self.assertEqual(state.browser_origin(), "https://next.example.test:8443")
        self.assertEqual(
            {name: state.get()[name] for name in retired},
            retired,
        )
        with self.assertRaises(state.auth.PasswordRecordError):
            state.is_initialized()
        with self.assertRaises(ValueError):
            state.bind_browser_origin("http://public.example.test")

    def test_invalid_persisted_browser_origin_fails_loud(self) -> None:
        state._write({"browser_origin": "https://example.test/path"})

        with self.assertRaisesRegex(RuntimeError, "invalid browser origin"):
            state.browser_origin()

    def test_partial_local_supervisor_record_is_never_repaired(self) -> None:
        state._write({"supervisor_id": "a" * 32})

        with self.assertRaises(state.auth.PasswordRecordError):
            state.authentication_state()
        with self.assertRaises(state.supervisor.SupervisorAuthorityError):
            state.begin_supervisor_setup("violet otter lantern quartz 92")

    def test_uninitialized_state_admits_only_strict_reset_consumption_evidence(self) -> None:
        state._write({"consumed_host_resets": [{"digest": "a" * 64, "expires_at": 1_800_000_000}]})
        self.assertEqual(state.authentication_state(), "uninitialized")

        state._write({"consumed_host_resets": [{"digest": "not-a-digest", "expires_at": 1_800_000_000}]})
        with self.assertRaisesRegex(RuntimeError, "invalid host reset evidence"):
            state.authentication_state()


if __name__ == "__main__":
    unittest.main()
