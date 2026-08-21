"""Security contracts for Local Supervisor TOTP."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest import mock

from mfa_helper import code

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from mfa import totp

NOW = 1_800_000_000


class TotpTests(unittest.TestCase):
    def setUp(self) -> None:
        with mock.patch.object(totp.secrets, "token_bytes", return_value=b"A" * totp.SECRET_BYTES):
            self.record = totp.new_record(NOW)

    def code(self, step_offset: int = 0) -> str:
        timestamp = NOW + step_offset * totp.PERIOD_SECONDS
        return code(str(self.record["secret"]), timestamp)

    def test_pending_enrollment_is_resumable_and_contains_no_username_or_origin(self) -> None:
        enrollment = totp.enrollment(self.record)

        self.assertEqual(totp.state(self.record), "enrollment-required")
        self.assertEqual(enrollment.secret, "IFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKB")
        self.assertEqual(
            enrollment.uri,
            "otpauth://totp/Shimpz%20Supervisor?secret=IFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKB"
            "&issuer=Shimpz&digits=6&period=30",
        )
        self.assertNotIn("@", enrollment.uri)
        self.assertNotIn("localhost", enrollment.uri)

    def test_activation_persists_replay_protection_across_a_copied_restart_state(self) -> None:
        code = self.code()

        self.assertIs(totp.verify(self.record, code, NOW), totp.Verification.ACCEPTED)
        restarted = copy.deepcopy(self.record)

        self.assertEqual(totp.state(restarted), "configured")
        self.assertIs(totp.verify(restarted, code, NOW), totp.Verification.INVALID)
        self.assertIs(totp.verify(restarted, code, NOW + totp.PERIOD_SECONDS), totp.Verification.INVALID)
        fresh = self.code(1)
        self.assertIs(totp.verify(restarted, fresh, NOW + totp.PERIOD_SECONDS), totp.Verification.ACCEPTED)

    def test_accepts_the_closed_clock_window_once_and_rejects_older_steps(self) -> None:
        previous = self.code(-1)
        next_code = self.code(1)

        self.assertIs(totp.verify(self.record, next_code, NOW), totp.Verification.ACCEPTED)
        self.assertIs(totp.verify(self.record, previous, NOW), totp.Verification.INVALID)

    def test_failure_budget_is_durable_and_unlocks_into_a_new_window(self) -> None:
        for _ in range(totp.FAILURE_LIMIT - 1):
            self.assertIs(totp.verify(self.record, "000000", NOW), totp.Verification.INVALID)
        self.assertIs(totp.verify(self.record, "000000", NOW), totp.Verification.LOCKED)

        restarted = copy.deepcopy(self.record)
        self.assertIs(totp.verify(restarted, self.code(), NOW + 1), totp.Verification.LOCKED)
        later = NOW + totp.LOCK_SECONDS
        self.assertIs(totp.verify(restarted, code(str(restarted["secret"]), later), later), totp.Verification.ACCEPTED)

    def test_resuming_enrollment_preserves_the_durable_failure_budget(self) -> None:
        for _ in range(totp.FAILURE_LIMIT):
            totp.verify(self.record, "000000", NOW)

        totp.resume(self.record, NOW + 1)

        self.assertEqual(self.record["failures"], totp.FAILURE_LIMIT)
        self.assertEqual(self.record["locked_until"], NOW + totp.LOCK_SECONDS)
        self.assertIs(totp.verify(self.record, self.code(), NOW + 1), totp.Verification.LOCKED)
        self.assertLessEqual(self.record["failures"], totp.FAILURE_LIMIT)

    def test_pending_factor_expires_and_malformed_state_fails_closed(self) -> None:
        self.assertIs(
            totp.verify(self.record, self.code(), NOW + totp.ENROLLMENT_TTL_SECONDS + 1),
            totp.Verification.EXPIRED,
        )
        for field, value in (("secret", "bad"), ("status", "disabled"), ("failures", True)):
            malformed = copy.deepcopy(self.record)
            malformed[field] = value
            with self.subTest(field=field), self.assertRaises(totp.TotpStateError):
                totp.state(malformed)

    def test_primitive_and_shape_validation_fails_closed(self) -> None:
        for timestamp in (True, totp.PERIOD_SECONDS - 1):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                totp.new_record(timestamp)

        with (
            mock.patch.object(totp.base64, "b32decode", side_effect=ValueError),
            self.assertRaises(totp.TotpStateError),
        ):
            totp._decode_secret("A" * 32)
        with (
            mock.patch.object(totp.base64, "b32decode", return_value=b"short"),
            self.assertRaises(totp.TotpStateError),
        ):
            totp._decode_secret("A" * 32)
        with self.assertRaises(totp.TotpStateError):
            totp.state({})

    def test_pending_and_active_records_reject_cross_state_fields(self) -> None:
        malformed_pending = copy.deepcopy(self.record)
        malformed_pending["expires_at"] = NOW
        with self.assertRaises(totp.TotpStateError):
            totp.state(malformed_pending)

        self.assertIs(totp.verify(self.record, self.code(), NOW), totp.Verification.ACCEPTED)
        malformed_active = copy.deepcopy(self.record)
        malformed_active["expires_at"] = NOW
        with self.assertRaises(totp.TotpStateError):
            totp.state(malformed_active)
        with self.assertRaises(totp.TotpStateError):
            totp.enrollment(self.record)
        with self.assertRaises(totp.TotpStateError):
            totp.resume(self.record, NOW + 1)

    def test_non_text_code_is_rejected(self) -> None:
        self.assertIs(totp.verify(self.record, None, NOW), totp.Verification.INVALID)


if __name__ == "__main__":
    unittest.main()
