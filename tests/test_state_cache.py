from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa_helper import code, configure_supervisor

NOW = 1_800_000_000


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

    def test_pending_totp_projection_resumes_and_closes_after_activation(self) -> None:
        enrollment = state.begin_supervisor_setup("violet otter lantern quartz 92", now=NOW)

        self.assertEqual(state.totp_enrollment(), enrollment)
        resumed = state.resume_totp_enrollment(now=NOW + 1)
        self.assertEqual((resumed.secret, resumed.uri), (enrollment.secret, enrollment.uri))
        self.assertRegex(state.webauthn_user_id(), r"^[0-9a-f]{64}$")
        with self.assertRaises(RuntimeError):
            state.begin_supervisor_setup("violet otter lantern quartz 92", now=NOW)

        result = state.verify_totp(code(enrollment.secret, NOW + 1), enrollment=True, now=NOW + 1)
        self.assertIs(result, state.totp.Verification.ACCEPTED)
        with self.assertRaises(state.totp.TotpStateError):
            state.totp_enrollment()
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
