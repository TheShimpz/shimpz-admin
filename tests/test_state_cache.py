import stat
import sys
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa_helper import code, configure_supervisor, isolated_store

NOW = 1_800_000_000


class AdminStoreCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)

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

    def test_a_short_write_still_stores_the_complete_payload(self) -> None:
        real_write = state.os.write

        def one_byte_at_a_time(fd: int, data: bytes) -> int:
            return real_write(fd, bytes(data[:1]))

        with mock.patch.object(state.os, "write", side_effect=one_byte_at_a_time):
            state._write({"session_secret": "complete"})
        with state._STORE_LOCK:
            state._store_cache = None
        self.assertEqual(state.get(), {"session_secret": "complete"})

    def test_a_failed_write_leaves_no_temporary_file_and_the_next_write_succeeds(self) -> None:
        with mock.patch.object(state.os, "write", side_effect=OSError("disk full")), self.assertRaises(OSError):
            state._write({"session_secret": "lost"})
        self.assertEqual([path.name for path in state.STORE_PATH.parent.iterdir()], [])
        state._write({"session_secret": "next"})
        self.assertEqual(state.get(), {"session_secret": "next"})

    def test_a_temporary_file_left_by_a_killed_process_does_not_block_writes(self) -> None:
        leftover = state.STORE_PATH.with_name(f".{state.STORE_PATH.name}.{state.os.getpid()}.tmp")
        leftover.write_bytes(b"partial")

        state._write({"session_secret": "after-restart"})
        state._write({"session_secret": "again"})

        with state._STORE_LOCK:
            state._store_cache = None
        self.assertEqual(state.get(), {"session_secret": "again"})
        self.assertEqual(state.STORE_PATH.stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(path.name for path in state.STORE_PATH.parent.iterdir()), [leftover.name, "admin.json"])

    def test_a_write_fsyncs_the_file_before_replace_and_the_directory_after(self) -> None:
        events: list[str] = []
        real_fsync = state.os.fsync
        real_replace = state.os.replace

        def recording_fsync(fd: int) -> None:
            mode = state.os.fstat(fd).st_mode
            events.append("fsync-directory" if stat.S_ISDIR(mode) else "fsync-file")
            real_fsync(fd)

        def recording_replace(source: object, target: object) -> None:
            events.append("replace")
            real_replace(source, target)

        with (
            mock.patch.object(state.os, "fsync", side_effect=recording_fsync),
            mock.patch.object(state.os, "replace", side_effect=recording_replace),
        ):
            state._write({"session_secret": "durable"})

        self.assertEqual(events, ["fsync-file", "replace", "fsync-directory"])
        self.assertEqual(state.get(), {"session_secret": "durable"})

    def test_a_failed_fsync_is_never_acknowledged_and_removes_the_temporary(self) -> None:
        state._write({"session_secret": "previous"})
        real_fsync = state.os.fsync

        def failing_fsync(failing_directory: bool) -> Callable[[int], None]:
            def fsync(fd: int) -> None:
                if stat.S_ISDIR(state.os.fstat(fd).st_mode) is failing_directory:
                    raise OSError("I/O error")
                real_fsync(fd)

            return fsync

        with (
            mock.patch.object(state.os, "fsync", side_effect=failing_fsync(failing_directory=False)),
            self.assertRaisesRegex(OSError, "I/O error"),
        ):
            state._write({"session_secret": "unsynced-file"})
        self.assertEqual([path.name for path in state.STORE_PATH.parent.iterdir()], ["admin.json"])
        with state._STORE_LOCK:
            state._store_cache = None
        self.assertEqual(state.get(), {"session_secret": "previous"})

        with (
            mock.patch.object(state.os, "fsync", side_effect=failing_fsync(failing_directory=True)),
            self.assertRaisesRegex(OSError, "I/O error"),
        ):
            state._write({"session_secret": "unsynced-directory"})
        self.assertEqual([path.name for path in state.STORE_PATH.parent.iterdir()], ["admin.json"])

        state._write({"session_secret": "next"})
        self.assertEqual(state.get(), {"session_secret": "next"})

    def test_password_initialization_creates_one_persistent_local_supervisor(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        first = state.local_supervisor()

        self.assertRegex(first.supervisor_id, r"^[0-9a-f]{32}$")
        self.assertRegex(first.private_key_hex, r"^[0-9a-f]{64}$")
        self.assertEqual(state.local_supervisor(), first)

    def test_browser_origin_binding_learns_keeps_and_replaces_only_a_local_origin(self) -> None:
        with mock.patch.object(state, "_write", wraps=state._write) as write:
            self.assertEqual(state.bind_browser_origin("https://dev.example.test"), "learned")
            self.assertEqual(state.browser_origin(), "https://dev.example.test")
            self.assertEqual(state.bind_browser_origin("https://dev.example.test"), "unchanged")
            self.assertEqual(state.bind_browser_origin("https://next.example.test:8443"), "replaced")

        self.assertEqual(write.call_count, 2)
        self.assertEqual(state.browser_origin(), "https://next.example.test:8443")
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

    def test_pending_totp_projection_resumes_and_closes_after_activation(self) -> None:
        enrollment = state.begin_supervisor_setup("violet otter lantern quartz 92", now=NOW)

        resumed = state.resume_totp_enrollment(now=NOW + 1)
        self.assertEqual((resumed.secret, resumed.uri), (enrollment.secret, enrollment.uri))
        self.assertRegex(state.webauthn_user_id(), r"^[0-9a-f]{64}$")
        with self.assertRaises(RuntimeError):
            state.begin_supervisor_setup("violet otter lantern quartz 92", now=NOW)

        result = state.verify_totp(code(enrollment.secret, NOW + 1), enrollment=True, now=NOW + 1)
        self.assertIs(result, state.totp.Verification.ACCEPTED)
        with self.assertRaises(state.totp.TotpStateError):
            state.resume_totp_enrollment(now=NOW + 2)
        with self.assertRaises(state.totp.TotpStateError):
            state.verify_totp(code(enrollment.secret, NOW + 30), enrollment=True, now=NOW + 30)

    def test_logout_rotates_sessions_only_for_current_evidence(self) -> None:
        self.assertIs(state.revoke_sessions_for_logout("not-a-session"), False)
        secret = configure_supervisor(state, "violet otter lantern quartz 92")
        first = state.auth.issue_session(secret, "totp")
        second = state.auth.issue_session(secret, "webauthn")

        self.assertIs(state.revoke_sessions_for_logout("not-a-session"), False)
        self.assertEqual(state.get()["session_secret"], secret)
        self.assertIs(state.revoke_sessions_for_logout(first), True)

        rotated = state.get()["session_secret"]
        self.assertNotEqual(rotated, secret)
        self.assertIsNone(state.auth.verify_session(rotated, first))
        self.assertIsNone(state.auth.verify_session(rotated, second))
        self.assertIs(state.revoke_sessions_for_logout(first), False)

    def test_corrupt_factor_state_requires_bounded_recovery(self) -> None:
        configure_supervisor(state, "violet otter lantern quartz 92")
        data = state.get()
        data["totp"].pop("status")
        state._write(data)

        with self.assertRaises(state.auth.PasswordRecordError):
            state.authentication_state()

        self.assertEqual(state.classified_authentication_state(), "recovery-required")

    def test_authentication_projection_does_not_reclassify_store_failures(self) -> None:
        with (
            mock.patch.object(state, "authentication_state", side_effect=RuntimeError("store unavailable")),
            self.assertRaisesRegex(RuntimeError, "store unavailable"),
        ):
            state.classified_authentication_state()

    def test_uninitialized_state_admits_only_strict_reset_consumption_evidence(self) -> None:
        state._write({"consumed_host_resets": [{"digest": "a" * 64, "expires_at": 1_800_000_000}]})
        self.assertEqual(state.authentication_state(), "uninitialized")

        state._write({"consumed_host_resets": [{"digest": "not-a-digest", "expires_at": 1_800_000_000}]})
        with self.assertRaisesRegex(RuntimeError, "invalid host reset evidence"):
            state.authentication_state()

    def test_host_reset_consumption_rejects_malformed_and_over_capacity_evidence(self) -> None:
        for digest, expires_at, now in (("bad", NOW + 1, NOW), ("a" * 64, True, NOW), ("a" * 64, NOW + 1, True)):
            with self.subTest(digest=digest, expires_at=expires_at, now=now), self.assertRaises(ValueError):
                state.consume_host_reset_capability(digest, expires_at, now=now)

        over_capacity = [
            {"digest": f"{index:064x}", "expires_at": NOW + 1} for index in range(state.MAX_CONSUMED_HOST_RESETS + 1)
        ]
        with self.assertRaisesRegex(RuntimeError, "invalid host reset evidence"):
            state._validated_consumed_host_resets(over_capacity)


if __name__ == "__main__":
    unittest.main()
