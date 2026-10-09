"""Security contracts for the local Admin OAuth hostname handoff."""

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

    def _issue(
        self,
        *,
        team_id: object = "marketing",
        challenge_id: object = "a" * 32,
        callback_mode: str = "loopback",
        admin_session: object = None,
    ) -> handoff_store.OAuthPreparation:
        """Issue one handoff for this test's Admin session unless another session is named."""
        return self.store.issue(
            team_id=team_id,
            challenge_id=challenge_id,
            admin_session=self.session if admin_session is None else admin_session,
            callback_mode=callback_mode,
        )

    def _complete(self, completion_code: str, *, admin_session: str | None = None) -> handoff_store.OAuthCompletion:
        """Complete the Marketing out-of-band handoff for this test's Admin session unless another is named."""
        return self.store.complete(
            team_id="marketing",
            challenge_id="a" * 32,
            admin_session=self.session if admin_session is None else admin_session,
            completion_code=completion_code,
        )

    @staticmethod
    def _authorization_url(
        callback: str = "loopback",
        state: str = "b" * 43,
        scope: str = "dns.read dns.write offline_access zone.read",
    ) -> str:
        return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(
            {
                "scope": scope,
                "state": state,
                "code_challenge": "c" * 43,
                "callback": callback,
            }
        )

    def test_handoff_is_session_issued_bounded_and_one_use(self) -> None:
        preparation = self._issue(challenge_id="b" * 32)

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
        preparation = self._issue(challenge_id="b" * 32)
        self.now += 30
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")

        restarted = handoff_store.OAuthHandoffStore(ttl_seconds=30)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            restarted.consume(preparation.token, "loopback")
        for invalid in ("Marketing", "team/one", "", None):
            with self.assertRaises(handoff_store.OAuthHandoffError):
                self._issue(team_id=invalid, challenge_id="b" * 32)
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self._issue(challenge_id="not-a-challenge")

    def test_duplicate_and_capacity_limits_do_not_evict_live_handoffs(self) -> None:
        first = self._issue()
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "already pending"):
            self._issue()
        second = self._issue(team_id="sales", challenge_id="b" * 32, callback_mode="local-domain")
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "capacity"):
            self._issue(team_id="support", challenge_id="c" * 32)
        self.store.authorize(first.token, self.authorization_url)
        domain_url = self._authorization_url("local-domain")
        self.store.authorize(second.token, domain_url)
        self.assertEqual(self.store.consume(first.token, "loopback").authorization_url, self.authorization_url)
        self.assertEqual(self.store.consume(second.token, "local-domain").authorization_url, domain_url)

    def test_logout_cancels_only_its_own_unconsumed_handoffs(self) -> None:
        other_session = "v1:9999999999:fedcba9876543210:" + "b" * 64
        first = self._issue()
        second = self._issue(
            team_id="sales", challenge_id="b" * 32, callback_mode="local-domain", admin_session=other_session
        )

        domain_url = self._authorization_url("local-domain")
        self.store.authorize(second.token, domain_url)
        self.assertEqual(self.store.cancel_session(self.session), 1)
        with self.assertRaises(handoff_store.OAuthHandoffError):
            self.store.consume(first.token, "loopback")
        self.assertEqual(self.store.consume(second.token, "local-domain").authorization_url, domain_url)

    def test_unprepared_invalid_and_duplicate_authorization_fail_closed(self) -> None:
        preparation = self._issue()
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")

        second = self._issue()
        for invalid in (
            "http://shimpz.com/api/oauth/cloudflare/start",
            "https://evil.example/start",
            "",
            None,
            self.authorization_url.replace("/start?", "/st\nart?"),
            self.authorization_url.replace("+", " "),
            self.authorization_url.replace("/start?", "/start;?"),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(handoff_store.OAuthHandoffError):
                self.store.authorize(second.token, invalid)
        self.store.authorize(second.token, self.authorization_url)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.authorize(second.token, self.authorization_url)

    def test_callback_mode_mismatch_consumes_the_handoff(self) -> None:
        preparation = self._issue(callback_mode="local-domain")
        self.store.authorize(preparation.token, self._authorization_url("local-domain"))
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "loopback")
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(preparation.token, "local-domain")

    def test_out_of_band_completion_is_session_state_bound_and_one_use(self) -> None:
        preparation = self._issue(callback_mode="out-of-band")
        self.store.authorize(preparation.token, self._authorization_url("out-of-band"))
        code = "c1." + "b" * 43 + "." + "a" * 64

        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self._complete(code, admin_session="v1:9999999999:fedcba9876543210:" + "d" * 64)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self._complete("c1." + "x" * 43 + "." + "a" * 64)

        completion = self._complete(code)
        self.assertEqual((completion.state, completion.claim), ("b" * 43, "a" * 64))
        self.assertEqual(completion.session_binding, preparation.session_binding)
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self._complete(code)

    def test_cancel_returns_only_the_exact_pending_team_binding(self) -> None:
        preparation = self._issue(callback_mode="out-of-band")
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
            lambda: self._issue(admin_session="short"),
            lambda: self._issue(callback_mode="invalid"),
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
            self._authorization_url(callback="local-domain"),
            self._authorization_url(scope="dns.write dns.read"),
            self._authorization_url(scope="dns.read dns.read"),
            self._authorization_url(scope="account.write"),
            self._authorization_url(scope=""),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(handoff_store.OAuthHandoffError):
                handoff_store._authorization_url(value, "loopback")
        read_only = self._authorization_url(scope="dns.read offline_access zone.read")
        self.assertEqual(
            handoff_store._authorization_url(read_only, "loopback"),
            (read_only, "b" * 43),
        )

    def test_token_collision_discard_and_automatic_mode_are_closed(self) -> None:
        duplicate = "a" * 64
        unique = "b" * 64
        with mock.patch.object(handoff_store.secrets, "token_hex", side_effect=[duplicate, duplicate, unique]):
            first = self._issue()
            second = self._issue(team_id="sales", challenge_id="b" * 32, callback_mode="out-of-band")
        self.assertEqual((first.token, second.token), (duplicate, unique))
        self.store.authorize(second.token, self._authorization_url("out-of-band"))
        with self.assertRaisesRegex(handoff_store.OAuthHandoffError, "unavailable"):
            self.store.consume(second.token, "out-of-band")
        self.assertTrue(self.store.discard(first.token))
        self.assertFalse(self.store.discard(first.token))


if __name__ == "__main__":
    unittest.main()
