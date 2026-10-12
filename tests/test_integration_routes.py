"""The Admin-owned local OAuth browser bridge: the authorization calls and the start and callback routes."""

import asyncio
import sys
import unittest
from http.cookies import SimpleCookie
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

import app_import
from http_request import Peer, http_request, json_headers
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _request(method: str, url: str, *, body: bytes = b"", cookie: str = "", origin: str = "") -> Request:
    parsed = urlsplit(url)
    headers = [(b"host", parsed.netloc.encode("ascii"))]
    if body:
        headers.extend(json_headers(body))
    if cookie:
        headers.append((b"cookie", cookie.encode("ascii")))
    if origin:
        headers.append((b"origin", origin.encode("ascii")))
    return http_request(
        parsed.path,
        Peer(parsed.scheme, ("127.0.0.1", 1234), (parsed.hostname, parsed.port)),
        method=method,
        body=body,
        headers=headers,
        query=parsed.query.encode("ascii"),
    )


PAIR = {"assistant_id": "shimpz-cloudflare", "integration_id": "cloudflare"}


class OAuthRoutesTest(unittest.TestCase):
    def test_local_profile_registers_only_the_oauth_start_and_callback_routes(self) -> None:
        routes = app_import.route_methods(self.admin_app)
        self.assertIn(("/api/oauth/cloudflare/start", "GET"), routes)
        self.assertIn(("/api/oauth/cloudflare/callback", "GET"), routes)

    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(root)
        cls.authorization = __import__("integrations.authorization", fromlist=["authorization"])
        cls.lane = __import__("session.lane", fromlist=["lane"])

    def setUp(self) -> None:
        handoffs = mock.patch.object(
            self.authorization, "HANDOFFS", self.admin_app.handoff_store.OAuthHandoffStore(ttl_seconds=30)
        )
        handoffs.start()
        self.addCleanup(handoffs.stop)
        self.session = "v1:9999999999:0123456789abcdef:" + "a" * 64

    def _authorize(self, origin: str, body: dict | None = None) -> tuple[int, dict]:
        """The Supervisor's Cloudflare authorization of challenge a*32, from a session socket bound to this origin."""
        return self.lane.http(
            self.authorization.authorize,
            "team_1",
            "a" * 32,
            PAIR if body is None else body,
            self.session,
            origin,
            self.admin_app._allowed_browser_origins,
        )

    def _complete(self, code: str) -> tuple[int, dict]:
        body = {"completion_code": code}
        return self.lane.http(self.authorization.complete, "team_1", "a" * 32, body, self.session)

    def _origins(self, origin: str):
        return mock.patch.object(self.admin_app, "_allowed_browser_origins", return_value=frozenset({origin}))

    def test_loopback_oauth_origin_is_fixed(self) -> None:
        self.assertEqual(self.authorization.OAUTH_ORIGINS["loopback"], "http://127.0.0.1:7777")

    @staticmethod
    def _cloudflare_authorization_url(callback: str = "loopback") -> str:
        return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(
            {
                "scope": "dns.read dns.write offline_access zone.read",
                "state": "b" * 43,
                "code_challenge": "c" * 43,
                "callback": callback,
            }
        )

    def test_an_authorization_from_loopback_returns_only_one_strict_loopback_handoff(self) -> None:
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url()},
        )
        with (
            self._origins("http://127.0.0.1:7777"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            status, body = self._authorize("http://127.0.0.1:7777")

        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"authorization_url", "completion_mode"})
        self.assertEqual(body["completion_mode"], "automatic")
        parsed = urlsplit(body["authorization_url"])
        self.assertEqual(
            (parsed.scheme, parsed.hostname, parsed.port, parsed.path, parsed.fragment),
            ("http", "127.0.0.1", 7777, "/api/oauth/cloudflare/start", ""),
        )
        query = parse_qs(parsed.query, strict_parsing=True)
        self.assertEqual(set(query), {"handoff"})
        self.assertRegex(query["handoff"][0], r"^[0-9a-f]{64}$")
        arguments = start.call_args.args
        self.assertEqual(arguments[:4], ("team_1", "a" * 32, "shimpz-cloudflare", "cloudflare"))
        self.assertRegex(arguments[4], r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(arguments[5], "loopback")

    def test_authorization_failure_always_releases_the_handoff_reservation(self) -> None:
        with (
            self._origins("http://127.0.0.1:7777"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                side_effect=RuntimeError("unexpected Team client failure"),
            ),
            self.assertRaisesRegex(RuntimeError, "unexpected Team client failure"),
        ):
            self._authorize("http://127.0.0.1:7777")

        replacement = self.authorization.HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        self.assertTrue(self.authorization.HANDOFFS.discard(replacement.token))

    def test_loopback_start_consumes_once_and_sets_browser_only_callback_binding(self) -> None:
        preparation = self.authorization.HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        self.authorization.HANDOFFS.authorize(preparation.token, self._cloudflare_authorization_url())
        request = _request(
            "GET",
            f"http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff={preparation.token}",
        )
        with mock.patch.object(
            self.admin_app.integrations,
            "start_local_assistant_integration_authorization",
            side_effect=AssertionError("loopback handoff must not call Team"),
        ) as start:
            response = asyncio.run(self.admin_app.oauth_cloudflare_start(request, preparation.token))
            replay = asyncio.run(self.admin_app.oauth_cloudflare_start(request, preparation.token))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], self._cloudflare_authorization_url())
        cookie = SimpleCookie()
        cookie.load(response.headers["set-cookie"])
        binding = cookie["shimpz_oauth_binding"]
        self.assertRegex(binding.value, r"^[A-Za-z0-9_-]{43}$")
        self.assertTrue(binding["httponly"])
        self.assertEqual(binding["samesite"].lower(), "lax")
        self.assertEqual(binding["path"], "/api/oauth/cloudflare")
        self.assertEqual(binding["max-age"], "300")
        self.assertFalse(binding["secure"])
        start.assert_not_called()
        self.assertEqual(replay.status_code, 303)
        self.assertEqual(replay.headers["location"], "/chat?oauth=start-failed")

    def test_local_domain_handoff_start_and_callback_use_only_the_named_https_origin(self) -> None:
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url("local-domain")},
        )
        with (
            self._origins("https://local.shimpz.com"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ),
        ):
            _status, authorized = self._authorize("https://local.shimpz.com")
        authorization_url = urlsplit(authorized["authorization_url"])
        self.assertEqual(
            (authorization_url.scheme, authorization_url.netloc, authorization_url.path),
            ("https", "local.shimpz.com", "/api/oauth/cloudflare/start"),
        )

        handoff = parse_qs(authorization_url.query, strict_parsing=True)["handoff"][0]
        start_request = _request("GET", authorization_url.geturl())
        with (
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://local.shimpz.com"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                side_effect=AssertionError("authorized handoff must not call Team"),
            ),
        ):
            started = asyncio.run(self.admin_app.oauth_cloudflare_start(start_request, handoff))
        cookie = SimpleCookie()
        cookie.load(started.headers["set-cookie"])
        binding = cookie["shimpz_oauth_binding"]
        self.assertEqual(started.status_code, 303)
        self.assertEqual(
            started.headers["location"],
            self._cloudflare_authorization_url("local-domain"),
        )
        self.assertTrue(binding["secure"])
        self.assertEqual(binding["samesite"].lower(), "none")

        callback = _request(
            "GET",
            "https://local.shimpz.com/api/oauth/cloudflare/callback?state=" + "b" * 43 + "&claim=" + "a" * 64,
            cookie=f"shimpz_oauth_binding={binding.value}",
        )
        completed = self.admin_app.team.TeamResponse(200, {"connected": True})
        with (
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://local.shimpz.com"),
            mock.patch.object(
                self.admin_app.integrations,
                "complete_cloudflare_oauth_callback",
                return_value=completed,
            ) as complete,
        ):
            response = asyncio.run(self.admin_app.oauth_cloudflare_callback(callback))
        self.assertEqual(response.headers["location"], "/chat")
        complete.assert_called_once_with(
            state="b" * 43,
            claim="a" * 64,
            session_binding=binding.value,
        )

        for origin in ("http://local.shimpz.com", "https://local.shimpz.com:444"):
            rejected = _request("GET", origin + "/api/oauth/cloudflare/start?handoff=" + "f" * 64)
            result = asyncio.run(self.admin_app.oauth_cloudflare_start(rejected, "f" * 64))
            self.assertEqual(result.headers["location"], "/chat?oauth=start-failed")

    def test_replacing_the_admitted_https_origin_invalidates_a_pending_handoff(self) -> None:
        preparation = self.authorization.HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="local-domain",
        )
        self.authorization.HANDOFFS.authorize(
            preparation.token,
            self._cloudflare_authorization_url("local-domain"),
        )
        request = _request(
            "GET",
            "https://local.shimpz.com/api/oauth/cloudflare/start?handoff=" + preparation.token,
        )
        with mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://replacement.example"):
            rejected = asyncio.run(self.admin_app.oauth_cloudflare_start(request, preparation.token))
        with mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://local.shimpz.com"):
            replay = asyncio.run(self.admin_app.oauth_cloudflare_start(request, preparation.token))

        self.assertEqual(rejected.headers["location"], "/chat?oauth=start-failed")
        self.assertEqual(replay.headers["location"], "/chat?oauth=start-failed")

    def test_localhost_and_custom_ports_cannot_start_oauth_authorization(self) -> None:
        origins = ("http://localhost:7777", "http://127.0.0.1:49123")
        with mock.patch.object(self.admin_app, "_allowed_browser_origins", return_value=frozenset(origins)):
            for origin in origins:
                with self.subTest(origin=origin):
                    self.assertEqual(self._authorize(origin)[0], 409)
            # An Origin the page no longer holds an admission for never starts one.
            self.assertEqual(self._authorize("http://127.0.0.1:7777")[0], 403)

    def test_custom_https_address_completes_out_of_band_in_the_original_session(self) -> None:
        provider_url = self._cloudflare_authorization_url("out-of-band")
        provider = self.admin_app.team.TeamResponse(200, {"authorization_url": provider_url})
        with (
            self._origins("https://developer.example.test"),
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://developer.example.test"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            _status, body = self._authorize("https://developer.example.test")
        self.assertEqual(body, {"authorization_url": provider_url, "completion_mode": "code"})
        binding = start.call_args.args[4]
        self.assertEqual(start.call_args.args[5], "out-of-band")

        code = "c1." + "b" * 43 + "." + "d" * 64
        completed = self.admin_app.team.TeamResponse(
            200,
            {
                "connected": True,
                "team_id": "team_1",
                "assistant_id": "shimpz-cloudflare",
                "integration_id": "cloudflare",
            },
        )
        with mock.patch.object(
            self.admin_app.integrations,
            "complete_cloudflare_oauth_callback",
            return_value=completed,
        ) as complete:
            status, response = self._complete(code)
            replay = self._complete(code)
        self.assertEqual((status, response["connected"]), (200, True))
        complete.assert_called_once_with(state="b" * 43, claim="d" * 64, session_binding=binding)
        self.assertEqual(replay[0], 409)

    def test_custom_https_authorization_cancel_releases_the_exact_team_binding(self) -> None:
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url("out-of-band")},
        )
        with (
            self._origins("https://developer.example.test"),
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://developer.example.test"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            self._authorize("https://developer.example.test")

        cancelled = self.admin_app.team.TeamResponse(204, {})
        with mock.patch.object(
            self.admin_app.integrations,
            "cancel_local_assistant_integration_authorization",
            return_value=cancelled,
        ) as cancel:
            response = self.lane.http(self.authorization.cancel, "team_1", "a" * 32, self.session)
            # Nothing pending any more is already cancelled, without asking Team again.
            again = self.lane.http(self.authorization.cancel, "team_1", "a" * 32, self.session)
        self.assertEqual((response, again), ((204, {}), (204, {})))
        cancel.assert_called_once_with("team_1", "a" * 32, start.call_args.args[4])

    def test_callback_forwards_exact_proof_then_removes_it_from_the_browser_url(self) -> None:
        binding = "d" * 43
        state = "b" * 43
        claim = "a" * 64
        request = _request(
            "GET",
            f"http://127.0.0.1:7777/api/oauth/cloudflare/callback?state={state}&claim={claim}",
            cookie=f"shimpz_oauth_binding={binding}",
        )
        result = self.admin_app.team.TeamResponse(
            200,
            {
                "connected": True,
                "team_id": "team_1",
                "assistant_id": "shimpz-cloudflare",
                "integration_id": "x-integration",
            },
        )
        with mock.patch.object(
            self.admin_app.integrations,
            "complete_cloudflare_oauth_callback",
            return_value=result,
        ) as complete:
            response = asyncio.run(self.admin_app.oauth_cloudflare_callback(request))

        complete.assert_called_once_with(state=state, claim=claim, session_binding=binding)
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/chat")
        self.assertNotIn(claim, response.headers["location"])
        self.assertNotIn(state, response.headers["location"])
        self.assertIn("shimpz_oauth_binding=", response.headers["set-cookie"])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")

    def test_callback_rejects_duplicate_extra_and_cross_host_queries_without_controller_io(self) -> None:
        requests = (
            _request(
                "GET",
                "http://127.0.0.1:7777/api/oauth/cloudflare/callback?state="
                + "a" * 43
                + "&state="
                + "b" * 43
                + "&claim="
                + "d" * 64,
                cookie="shimpz_oauth_binding=" + "c" * 43,
            ),
            _request(
                "GET",
                "http://127.0.0.1:7777/api/oauth/cloudflare/callback?state="
                + "a" * 43
                + "&claim="
                + "d" * 64
                + "&access_token=must-not-cross",
                cookie="shimpz_oauth_binding=" + "c" * 43,
            ),
            _request(
                "GET",
                "http://localhost:7777/api/oauth/cloudflare/callback?state=" + "a" * 43 + "&claim=" + "d" * 64,
                cookie="shimpz_oauth_binding=" + "c" * 43,
            ),
        )
        with mock.patch.object(self.admin_app.integrations, "complete_cloudflare_oauth_callback") as complete:
            responses = [asyncio.run(self.admin_app.oauth_cloudflare_callback(request)) for request in requests]
        complete.assert_not_called()
        self.assertTrue(all(response.headers["location"] == "/chat?oauth=callback-failed" for response in responses))

    def test_authorize_body_requires_only_the_exact_integration_pair(self) -> None:
        for body in (
            {},
            {"assistant_id": "shimpz-cloudflare"},
            {"assistant_id": "shimpz-cloudflare", "integration_id": "cloudflare", "client_id": "must-not-cross"},
        ):
            # The body is refused before the callback mode is chosen, whatever the page's Origin.
            with self.subTest(body=body):
                self.assertEqual(self._authorize("http://localhost:7777", body)[0], 400)


if __name__ == "__main__":
    unittest.main()
