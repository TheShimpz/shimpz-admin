"""Security contracts for the local Admin OAuth hostname handoff."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from integrations import handoff as handoff_store


class OAuthHandoffStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 10.0
        self.store = handoff_store.OAuthHandoffStore(
            capacity=2,
            ttl_seconds=30,
            clock=lambda: self.now,
        )
        self.session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        self.authorization_url = (
            "https://shimpz.com/api/oauth/cloudflare/start?"
            "scope=dns.read&state=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        )

    def test_handoff_is_session_issued_bounded_and_one_use(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
        )

        self.assertRegex(preparation.token, r"^[0-9a-f]{64}$")
        self.assertRegex(preparation.session_binding, r"^[A-Za-z0-9_-]{43}$")
        self.store.authorize(preparation.token, self.authorization_url)
        handoff = self.store.consume(preparation.token)
        self.assertEqual(handoff.authorization_url, self.authorization_url)
        self.assertRegex(handoff.session_binding, r"^[A-Za-z0-9_-]{43}$")
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token)

    def test_expiry_restart_and_wrong_shapes_fail_closed(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
        )
        self.now += 30
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token)

        restarted = handoff_store.OAuthHandoffStore(ttl_seconds=30)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            restarted.consume(preparation.token)
        for invalid in ("Marketing", "team/one", "", None):
            with self.assertRaises(handoff_store.OAuthHandoffError):
                self.store.issue(
                    team_id=invalid,
                    challenge_id="b" * 32,
                    admin_session=self.session,
                )
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self.store.issue(
                team_id="marketing",
                challenge_id="not-a-challenge",
                admin_session=self.session,
            )

    def test_duplicate_and_capacity_limits_do_not_evict_live_handoffs(self) -> None:
        first = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "already pending"):
            self.store.issue(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
            )
        second = self.store.issue(
            team_id="sales",
            challenge_id="b" * 32,
            admin_session=self.session,
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "capacity"):
            self.store.issue(
                team_id="support",
                challenge_id="c" * 32,
                admin_session=self.session,
            )
        self.store.authorize(first.token, self.authorization_url)
        self.store.authorize(second.token, self.authorization_url)
        self.assertEqual(self.store.consume(first.token).authorization_url, self.authorization_url)
        self.assertEqual(self.store.consume(second.token).authorization_url, self.authorization_url)

    def test_logout_cancels_only_its_own_unconsumed_handoffs(self) -> None:
        other_session = "v1:9999999999:fedcba9876543210:" + "b" * 64
        first = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
        )
        second = self.store.issue(
            team_id="sales",
            challenge_id="b" * 32,
            admin_session=other_session,
        )

        self.store.authorize(second.token, self.authorization_url)
        self.assertEqual(self.store.cancel_session(self.session), 1)
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self.store.consume(first.token)
        self.assertEqual(self.store.consume(second.token).authorization_url, self.authorization_url)

    def test_unprepared_invalid_and_duplicate_authorization_fail_closed(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token)

        second = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
        )
        for invalid in ("http://shimpz.com/api/oauth/cloudflare/start", "https://evil.example/start", "", None):
            with self.subTest(invalid=invalid), self.assertRaises(handoff_store.OAuthHandoffError):
                self.store.authorize(second.token, invalid)
        self.store.authorize(second.token, self.authorization_url)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.authorize(second.token, self.authorization_url)


if __name__ == "__main__":
    unittest.main()
