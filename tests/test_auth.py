"""Pure contracts for Local Supervisor password security."""

import asyncio
import hashlib
import hmac
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import auth

GOOD_PASSWORD = "violet otter lantern quartz 92"


class PasswordVerifierTests(unittest.TestCase):
    def test_current_verifier_is_strict_and_authenticates_exact_password(self) -> None:
        verifier = auth.new_password_verifier(GOOD_PASSWORD)
        record = {"password_verifier": verifier}

        self.assertEqual(auth.password_state({}), "uninitialized")
        self.assertEqual(auth.password_state(record), "configured")
        self.assertTrue(verifier.startswith("scrypt-v1$ln=14,r=8,p=5,dk=32$"))
        self.assertTrue(auth.verify_password(GOOD_PASSWORD, record))
        self.assertFalse(auth.verify_password("violet otter lantern quartz 93", record))

    def test_malformed_records_fail_closed(self) -> None:
        verifier = auth.new_password_verifier(GOOD_PASSWORD)
        invalid = (
            {"password_verifier": verifier.replace("p=5", "p=1")},
            {"password_verifier": "malformed"},
        )

        for record in invalid:
            with self.subTest(record=record), self.assertRaises(auth.PasswordRecordError):
                auth.password_state(record)

    def test_setup_policy_rejects_short_common_and_repeated_passwords(self) -> None:
        cases = {
            "short": "password-too-short",
            " " * auth.MIN_PASSWORD_CHARS: "password-too-short",
            "violet otter" + " " * auth.MIN_PASSWORD_CHARS: "password-too-short",
            "a" + " " * 20 + "b": "password-too-short",
            "ﬀ" * 8: "password-too-short",
            "correct horse battery staple": "password-blocklisted",
            "Shimpz Admin Password": "password-blocklisted",
            "abcabcabcabcabc": "password-blocklisted",
            "x" * (auth.MAX_PASSWORD_CHARS + 1): "password-too-long",
        }

        for password, expected in cases.items():
            with self.subTest(password=password[:32]):
                self.assertEqual(auth.password_policy(password), expected)
        self.assertIsNone(auth.password_policy(GOOD_PASSWORD))

    def test_sessions_carry_only_signed_current_mfa_evidence(self) -> None:
        secret = auth.new_secret()
        token = auth.issue_session(secret, "totp")
        evidence = auth.verify_session(secret, token)

        self.assertEqual(evidence.method, "totp")
        self.assertIsNone(auth.verify_session(secret, token.replace("pwd+totp", "pwd+webauthn")))
        self.assertIsNone(auth.verify_session(secret, "unknown:9999999999:nonce:pwd+totp:" + "0" * 64))
        with self.assertRaises(ValueError):
            auth.issue_session(secret, "password")

    def test_invalid_password_and_session_inputs_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            auth.new_password_verifier("short")
        with self.assertRaises(auth.PasswordRecordError):
            auth.password_state(None)
        with self.assertRaises(ValueError):
            auth.verify_password("", {})
        with self.assertRaises(auth.PasswordRecordError):
            auth.verify_password(GOOD_PASSWORD, {})

        secret = auth.new_secret()
        scheme = auth._SESSION_SCHEME
        self.assertIsNone(auth.verify_session("not-hex", f"{scheme}:9999999999:nonce:pwd+totp:{'0' * 64}"))
        body = f"{scheme}:not-a-time:nonce:pwd+totp"
        signature = hmac.new(bytes.fromhex(secret), body.encode(), hashlib.sha256).hexdigest()
        self.assertIsNone(auth.verify_session(secret, f"{body}:{signature}"))

    def test_a_session_ends_a_day_after_its_sign_in_however_active(self) -> None:
        secret = auth.new_secret()
        now = int(time.time())
        for issued_at, valid in ((now - auth.TTL + 60, True), (now - auth.TTL, False), (now + 60, False)):
            with self.subTest(issued_at=issued_at - now):
                token = auth.issue_session(secret, "totp", issued_at=issued_at)
                evidence = auth.verify_session(secret, token, activity=True)
                self.assertEqual(evidence is not None, valid)
        evidence = auth.verify_session(secret, auth.issue_session(secret, "webauthn", issued_at=now - 10))
        self.assertEqual((evidence.issued_at, evidence.expires_at), (now - 10, now - 10 + auth.TTL))

    def test_only_activity_restarts_a_tracked_session_idle_time(self) -> None:
        now = [0.0]
        sessions = auth.SessionActivity(clock=lambda: now[0], idle_seconds=3600)
        sessions.register("polled")
        sessions.register("attended")
        now[0] = 3000
        self.assertTrue(sessions.current("polled", activity=False))
        self.assertTrue(sessions.current("attended", activity=True))
        now[0] = 3600
        self.assertFalse(sessions.current("polled", activity=True))
        self.assertTrue(sessions.current("attended", activity=False))
        now[0] = 6600
        self.assertFalse(sessions.current("attended", activity=True))
        self.assertFalse(sessions.current("never-issued", activity=True))

    def test_tracking_is_bounded_and_evicts_the_least_recent_session(self) -> None:
        now = [0.0]
        sessions = auth.SessionActivity(clock=lambda: now[0], capacity=2)
        for index, token in enumerate(("first", "second", "third")):
            now[0] = index
            sessions.register(token)
        self.assertEqual(
            [sessions.current(token, activity=False) for token in ("first", "second", "third")], [False, True, True]
        )

    def test_session_signature_must_be_lowercase_ascii_hex_before_comparison(self) -> None:
        secret = auth.new_secret()
        token = auth.issue_session(secret, "totp")
        body, _separator, signature = token.rpartition(":")
        # Starlette decodes cookie bytes as Latin-1, so a UTF-8 cookie arrives as non-ASCII text.
        for forged in ("\u00c3\u00a9" * 32, signature[:-1] + "\u00e9", signature.upper(), "signature", signature + "0"):
            with self.subTest(forged=forged):
                self.assertIsNone(auth.verify_session(secret, f"{body}:{forged}"))
        self.assertIsNotNone(auth.verify_session(secret, token))


class LocalLoginLimiterTests(unittest.TestCase):
    def test_unbalanced_permit_release_is_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            auth.LocalLoginLimiter().finish(rejected=None)

    def test_cancelled_attempt_retains_its_slot_until_the_worker_finishes(self) -> None:
        started = threading.Event()
        release = threading.Event()
        limiter = auth.LocalLoginLimiter()

        def verify(_password: str, _record: object) -> bool:
            started.set()
            self.assertTrue(release.wait(timeout=2))
            return True

        async def exercise() -> None:
            with mock.patch.object(auth, "verify_password", side_effect=verify):
                attempt = asyncio.create_task(auth.attempt_login(GOOD_PASSWORD, {}, limiter))
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                attempt.cancel()
                await asyncio.sleep(0)
                self.assertFalse(attempt.done())
                with self.assertRaises(auth.LoginRateLimitedError):
                    limiter.begin()
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await attempt
                limiter.begin()
                self.assertEqual(limiter.finish(rejected=None), 0)

        asyncio.run(exercise())

    def test_attempt_login_releases_its_slot_after_invalid_record(self) -> None:
        limiter = auth.LocalLoginLimiter()

        with self.assertRaises(auth.PasswordRecordError):
            asyncio.run(auth.attempt_login(GOOD_PASSWORD, {"password_verifier": "invalid"}, limiter))

        verifier = auth.new_password_verifier(GOOD_PASSWORD)
        self.assertEqual(
            asyncio.run(auth.attempt_login(GOOD_PASSWORD, {"password_verifier": verifier}, limiter)),
            (True, 0),
        )

    def test_in_flight_refusal_does_not_consume_a_password_rejection(self) -> None:
        now = [100.0]
        limiter = auth.LocalLoginLimiter(clock=lambda: now[0], failure_limit=2, lock_seconds=60)

        limiter.begin()
        with self.assertRaises(auth.LoginRateLimitedError) as caught:
            limiter.begin()
        self.assertEqual(caught.exception.retry_after, 1)
        self.assertEqual(limiter.finish(rejected=None), 0)

        limiter.begin()
        self.assertEqual(limiter.finish(rejected=True), 0)
        limiter.begin()
        self.assertEqual(limiter.finish(rejected=True), 60)

    def test_lock_expires_and_success_resets_rejections(self) -> None:
        now = [100.0]
        limiter = auth.LocalLoginLimiter(clock=lambda: now[0], failure_limit=2, lock_seconds=60)

        for expected in (0, 60):
            limiter.begin()
            self.assertEqual(limiter.finish(rejected=True), expected)
        with self.assertRaises(auth.LoginRateLimitedError) as caught:
            limiter.begin()
        self.assertEqual(caught.exception.retry_after, 60)

        now[0] = 160.0
        limiter.begin()
        self.assertEqual(limiter.finish(rejected=False), 0)
        limiter.begin()
        self.assertEqual(limiter.finish(rejected=True), 0)


if __name__ == "__main__":
    unittest.main()
