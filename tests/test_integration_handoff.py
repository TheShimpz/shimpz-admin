"""Security contracts for the local Admin OAuth hostname handoff."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

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
        self.authorization_url = self._authorization_url()

    @staticmethod
    def _authorization_url(callback: str = "loopback", state: str = "b" * 43) -> str:
        return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(
            {
                "scope": "dns.read offline_access zone.read",
                "state": state,
                "code_challenge": "c" * 43,
                "callback": callback,
            }
        )

    def test_handoff_is_session_issued_bounded_and_one_use(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )

        self.assertRegex(preparation.token, r"^[0-9a-f]{64}$")
        self.assertRegex(preparation.session_binding, r"^[A-Za-z0-9_-]{43}$")
        self.store.authorize(preparation.token, self.authorization_url)
        handoff = self.store.consume(preparation.token, "loopback")
        self.assertEqual(handoff.authorization_url, self.authorization_url)
        self.assertRegex(handoff.session_binding, r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(handoff.callback_mode, "loopback")
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")

    def test_expiry_restart_and_wrong_shapes_fail_closed(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="b" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        self.now += 30
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")

        restarted = handoff_store.OAuthHandoffStore(ttl_seconds=30)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            restarted.consume(preparation.token, "loopback")
        for invalid in ("Marketing", "team/one", "", None):
            with self.assertRaises(handoff_store.OAuthHandoffError):
                self.store.issue(
                    team_id=invalid,
                    challenge_id="b" * 32,
                    admin_session=self.session,
                    callback_mode="loopback",
                )
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self.store.issue(
                team_id="marketing",
                challenge_id="not-a-challenge",
                admin_session=self.session,
                callback_mode="loopback",
            )

    def test_duplicate_and_capacity_limits_do_not_evict_live_handoffs(self) -> None:
        first = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "already pending"):
            self.store.issue(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
                callback_mode="loopback",
            )
        second = self.store.issue(
            team_id="sales",
            challenge_id="b" * 32,
            admin_session=self.session,
            callback_mode="hosted",
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "capacity"):
            self.store.issue(
                team_id="support",
                challenge_id="c" * 32,
                admin_session=self.session,
                callback_mode="loopback",
            )
        self.store.authorize(first.token, self.authorization_url)
        hosted_url = self._authorization_url("hosted")
        self.store.authorize(second.token, hosted_url)
        self.assertEqual(self.store.consume(first.token, "loopback").authorization_url, self.authorization_url)
        self.assertEqual(self.store.consume(second.token, "hosted").authorization_url, hosted_url)

    def test_logout_cancels_only_its_own_unconsumed_handoffs(self) -> None:
        other_session = "v1:9999999999:fedcba9876543210:" + "b" * 64
        first = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        second = self.store.issue(
            team_id="sales",
            challenge_id="b" * 32,
            admin_session=other_session,
            callback_mode="hosted",
        )

        hosted_url = self._authorization_url("hosted")
        self.store.authorize(second.token, hosted_url)
        self.assertEqual(self.store.cancel_session(self.session), 1)
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self.store.consume(first.token, "loopback")
        self.assertEqual(self.store.consume(second.token, "hosted").authorization_url, hosted_url)

    def test_unprepared_invalid_and_duplicate_authorization_fail_closed(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")

        second = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        for invalid in ("http://shimpz.com/api/oauth/cloudflare/start", "https://evil.example/start", "", None):
            with self.subTest(invalid=invalid), self.assertRaises(handoff_store.OAuthHandoffError):
                self.store.authorize(second.token, invalid)
        self.store.authorize(second.token, self.authorization_url)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.authorize(second.token, self.authorization_url)

    def test_callback_mode_mismatch_consumes_the_handoff(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="hosted",
        )
        self.store.authorize(preparation.token, self._authorization_url("hosted"))
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "hosted")

    def test_out_of_band_completion_is_session_state_bound_and_one_use(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="out-of-band",
        )
        self.store.authorize(preparation.token, self._authorization_url("out-of-band"))
        code = "c1." + "b" * 43 + "." + "a" * 64

        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.complete(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session="v1:9999999999:fedcba9876543210:" + "d" * 64,
                completion_code=code,
            )
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.complete(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
                completion_code="c1." + "x" * 43 + "." + "a" * 64,
            )

        completion = self.store.complete(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            completion_code=code,
        )
        self.assertEqual((completion.state, completion.claim), ("b" * 43, "a" * 64))
        self.assertEqual(completion.session_binding, preparation.session_binding)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.complete(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
                completion_code=code,
            )

    def test_cancel_returns_only_the_exact_pending_team_binding(self) -> None:
        preparation = self.store.issue(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="out-of-band",
        )
        self.store.authorize(preparation.token, self._authorization_url("out-of-band"))

        self.assertIsNone(
            self.store.cancel(
                team_id="marketing",
                challenge_id="b" * 32,
                admin_session=self.session,
            )
        )
        self.assertEqual(
            self.store.cancel(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
            ),
            preparation.session_binding,
        )
        self.assertIsNone(
            self.store.cancel(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
            )
        )

    def test_closed_helpers_and_limits_reject_invalid_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "limits"):
            handoff_store.OAuthHandoffStore(capacity=0, ttl_seconds=30)
        for operation in (
            lambda: self.store.issue(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session="short",
                callback_mode="loopback",
            ),
            lambda: self.store.issue(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
                callback_mode="invalid",
            ),
            lambda: self.store.consume("bad", "loopback"),
            lambda: handoff_store._completion_code(None),
            lambda: handoff_store._completion_code("bad"),
        ):
            with self.assertRaises(handoff_store.OAuthHandoffError):
                operation()

    def test_authorization_url_parser_rejects_invalid_query_and_port(self) -> None:
        invalid = (
            "https://shimpz.com:bad/api/oauth/cloudflare/start?x=1",
            self._authorization_url(state="bad"),
            self._authorization_url(callback="hosted"),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(handoff_store.OAuthHandoffError):
                handoff_store._authorization_url(value, "loopback")

    def test_token_collision_discard_and_automatic_mode_are_closed(self) -> None:
        duplicate = "a" * 64
        unique = "b" * 64
        with mock.patch.object(handoff_store.secrets, "token_hex", side_effect=[duplicate, duplicate, unique]):
            first = self.store.issue(
                team_id="marketing",
                challenge_id="a" * 32,
                admin_session=self.session,
                callback_mode="loopback",
            )
            second = self.store.issue(
                team_id="sales",
                challenge_id="b" * 32,
                admin_session=self.session,
                callback_mode="out-of-band",
            )
        self.assertEqual((first.token, second.token), (duplicate, unique))
        self.store.authorize(second.token, self._authorization_url("out-of-band"))
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(second.token, "out-of-band")
        self.assertTrue(self.store.discard(first.token))
        self.assertFalse(self.store.discard(first.token))


if __name__ == "__main__":
    unittest.main()
