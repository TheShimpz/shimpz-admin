"""Security contracts for the local Admin OAuth hostname handoff."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import oauth_handoff


class OAuthHandoffStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 10.0
        self.store = oauth_handoff.OAuthHandoffStore(
            capacity=2,
            ttl_seconds=30,
            clock=lambda: self.now,
        )
        self.session = "v1:9999999999:0123456789abcdef:" + "a" * 64

    def test_handoff_is_session_issued_bounded_and_one_use(self) -> None:
        token = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
        )

        self.assertRegex(token, r"^[A-Za-z0-9_-]{43}$")
        handoff = self.store.consume(token)
        self.assertEqual(handoff.team_id, "marketing")
        self.assertEqual(handoff.challenge_id, "b" * 32)
        self.assertRegex(handoff.session_binding, r"^[A-Za-z0-9_-]{43}$")
        with self.assertRaisesRegex(oauth_handoff.OAuthHandoffError, "unavailable"):
            self.store.consume(token)

    def test_expiry_restart_and_wrong_shapes_fail_closed(self) -> None:
        token = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
        )
        self.now += 30
        with self.assertRaisesRegex(oauth_handoff.OAuthHandoffError, "unavailable"):
            self.store.consume(token)

        restarted = oauth_handoff.OAuthHandoffStore(ttl_seconds=30)
        with self.assertRaisesRegex(oauth_handoff.OAuthHandoffError, "unavailable"):
            restarted.consume(token)
        for invalid in ("Marketing", "team/one", "", None):
            with self.assertRaises(oauth_handoff.OAuthHandoffError):
                self.store.issue(
                    team_id=invalid,
                    challenge_id="b" * 32,
                    admin_session=self.session,
                )
        with self.assertRaises(oauth_handoff.OAuthHandoffError):
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
        with self.assertRaisesRegex(oauth_handoff.OAuthHandoffError, "already pending"):
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
        with self.assertRaisesRegex(oauth_handoff.OAuthHandoffError, "capacity"):
            self.store.issue(
                team_id="support",
                challenge_id="c" * 32,
                admin_session=self.session,
            )
        self.assertEqual(self.store.consume(first).team_id, "marketing")
        self.assertEqual(self.store.consume(second).team_id, "sales")

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

        self.assertEqual(self.store.cancel_session(self.session), 1)
        with self.assertRaises(oauth_handoff.OAuthHandoffError):
            self.store.consume(first)
        self.assertEqual(self.store.consume(second).team_id, "sales")


if __name__ == "__main__":
    unittest.main()
