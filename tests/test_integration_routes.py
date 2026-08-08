"""Route contracts for the Admin-owned local OAuth browser bridge."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from http.cookies import SimpleCookie
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _request(method: str, url: str, *, body: bytes = b"", cookie: str = "", origin: str = "") -> Request:
    parsed = urlsplit(url)
    headers = [(b"host", parsed.netloc.encode("ascii"))]
    if body:
        headers.extend(
            [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ]
        )
    if cookie:
        headers.append((b"cookie", cookie.encode("ascii")))
    if origin:
        headers.append((b"origin", origin.encode("ascii")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": parsed.scheme,
        "path": parsed.path,
        "raw_path": parsed.path.encode("ascii"),
        "query_string": parsed.query.encode("ascii"),
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": (parsed.hostname, parsed.port),
    }
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


class OAuthRoutesTest(unittest.TestCase):
    def test_local_profile_registers_only_the_closed_oauth_route_methods(self) -> None:
        routes = {
            (route.path, method)
            for route in self.admin_app.app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        path = "/api/teams/{team_id}/assistant-integrations/challenges/{challenge_id}"

        self.assertIn((path + "/authorize", "POST"), routes)
        self.assertIn((path + "/complete", "POST"), routes)
        self.assertIn((path + "/authorize", "DELETE"), routes)

    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    def setUp(self) -> None:
        self.admin_app.OAUTH_HANDOFFS = self.admin_app.handoff_store.OAuthHandoffStore(
            ttl_seconds=30,
        )
        self.session = "v1:9999999999:0123456789abcdef:" + "a" * 64

    def test_loopback_oauth_origin_is_fixed(self) -> None:
        self.assertEqual(self.admin_app.OAUTH_ORIGINS["loopback"], "http://127.0.0.1:7777")

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

    def test_authenticated_post_returns_only_one_strict_loopback_handoff(self) -> None:
        request = _request(
            "POST",
            "http://127.0.0.1:7777/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32 + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="http://127.0.0.1:7777",
        )
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url()},
        )
        with (
            mock.patch.object(
                self.admin_app,
                "_allowed_browser_origins",
                return_value=frozenset({"http://127.0.0.1:7777"}),
            ),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            response = asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
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
        self.assertEqual(response.headers["cache-control"], "no-store")
        arguments = start.call_args.args
        self.assertEqual(arguments[:2], ("team_1", "a" * 32))
        self.assertRegex(arguments[2], r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(arguments[3], "loopback")

    def test_authorization_failure_always_releases_the_handoff_reservation(self) -> None:
        request = _request(
            "POST",
            "http://127.0.0.1:7777/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32 + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="http://127.0.0.1:7777",
        )
        with (
            mock.patch.object(
                self.admin_app,
                "_allowed_browser_origins",
                return_value=frozenset({"http://127.0.0.1:7777"}),
            ),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                side_effect=RuntimeError("unexpected Team client failure"),
            ),
            self.assertRaisesRegex(RuntimeError, "unexpected Team client failure"),
        ):
            asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request))

        replacement = self.admin_app.OAUTH_HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        self.assertTrue(self.admin_app.OAUTH_HANDOFFS.discard(replacement.token))

    def test_loopback_start_consumes_once_and_sets_browser_only_callback_binding(self) -> None:
        preparation = self.admin_app.OAUTH_HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="loopback",
        )
        self.admin_app.OAUTH_HANDOFFS.authorize(preparation.token, self._cloudflare_authorization_url())
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

    def test_hosted_handoff_start_and_callback_use_only_the_named_https_origin(self) -> None:
        authorize_request = _request(
            "POST",
            "https://local.shimpz.com/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32 + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="https://local.shimpz.com",
        )
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url("hosted")},
        )
        with (
            mock.patch.object(
                self.admin_app,
                "_allowed_browser_origins",
                return_value=frozenset({"https://local.shimpz.com"}),
            ),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ),
        ):
            authorized = asyncio.run(
                self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, authorize_request)
            )
        authorization_url = urlsplit(json.loads(authorized.body)["authorization_url"])
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
            self._cloudflare_authorization_url("hosted"),
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
        preparation = self.admin_app.OAUTH_HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
            callback_mode="hosted",
        )
        self.admin_app.OAUTH_HANDOFFS.authorize(
            preparation.token,
            self._cloudflare_authorization_url("hosted"),
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
                request = _request(
                    "POST",
                    origin + "/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32 + "/authorize",
                    body=b"{}",
                    cookie=f"shimpz_admin={self.session}",
                    origin=origin,
                )
                with self.subTest(origin=origin), self.assertRaises(HTTPException) as raised:
                    asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request))
                self.assertEqual(raised.exception.status_code, 409)

    def test_custom_https_address_completes_out_of_band_in_the_original_session(self) -> None:
        authorize_request = _request(
            "POST",
            "https://developer.example.test/api/teams/team_1/assistant-integrations/challenges/"
            + "a" * 32
            + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="https://developer.example.test",
        )
        provider_url = self._cloudflare_authorization_url("out-of-band")
        provider = self.admin_app.team.TeamResponse(200, {"authorization_url": provider_url})
        with (
            mock.patch.object(
                self.admin_app,
                "_allowed_browser_origins",
                return_value=frozenset({"https://developer.example.test"}),
            ),
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://developer.example.test"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            authorized = asyncio.run(
                self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, authorize_request)
            )
        body = json.loads(authorized.body)
        self.assertEqual(body, {"authorization_url": provider_url, "completion_mode": "code"})
        binding = start.call_args.args[2]
        self.assertEqual(start.call_args.args[3], "out-of-band")

        code = "c1." + "b" * 43 + "." + "d" * 64
        complete_request = _request(
            "POST",
            "https://developer.example.test/api/teams/team_1/assistant-integrations/challenges/"
            + "a" * 32
            + "/complete",
            body=json.dumps({"completion_code": code}).encode(),
            cookie=f"shimpz_admin={self.session}",
            origin="https://developer.example.test",
        )
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
            response = asyncio.run(
                self.admin_app.team_assistant_integration_complete("team_1", "a" * 32, complete_request)
            )
            replay_request = _request(
                "POST",
                "https://developer.example.test/api/teams/team_1/assistant-integrations/challenges/"
                + "a" * 32
                + "/complete",
                body=json.dumps({"completion_code": code}).encode(),
                cookie=f"shimpz_admin={self.session}",
                origin="https://developer.example.test",
            )
            with self.assertRaises(HTTPException) as replay:
                asyncio.run(self.admin_app.team_assistant_integration_complete("team_1", "a" * 32, replay_request))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body)["connected"], True)
        complete.assert_called_once_with(state="b" * 43, claim="d" * 64, session_binding=binding)
        self.assertEqual(replay.exception.status_code, 409)

    def test_custom_https_authorization_cancel_releases_the_exact_team_binding(self) -> None:
        authorize_request = _request(
            "POST",
            "https://developer.example.test/api/teams/team_1/assistant-integrations/challenges/"
            + "a" * 32
            + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="https://developer.example.test",
        )
        provider = self.admin_app.team.TeamResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url("out-of-band")},
        )
        with (
            mock.patch.object(
                self.admin_app,
                "_allowed_browser_origins",
                return_value=frozenset({"https://developer.example.test"}),
            ),
            mock.patch.object(self.admin_app.state, "browser_origin", return_value="https://developer.example.test"),
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=provider,
            ) as start,
        ):
            asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, authorize_request))

        cancel_request = _request(
            "DELETE",
            "https://developer.example.test/api/teams/team_1/assistant-integrations/challenges/"
            + "a" * 32
            + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
            origin="https://developer.example.test",
        )
        cancelled = self.admin_app.team.TeamResponse(204, {})
        with mock.patch.object(
            self.admin_app.integrations,
            "cancel_local_assistant_integration_authorization",
            return_value=cancelled,
        ) as cancel:
            response = asyncio.run(self.admin_app.team_assistant_integration_cancel("team_1", "a" * 32, cancel_request))
        self.assertEqual(response.status_code, 204)
        cancel.assert_called_once_with("team_1", "a" * 32, start.call_args.args[2])

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

    def test_inventory_and_disconnect_keep_the_public_contract_exact(self) -> None:
        inventory = self.admin_app.team.TeamResponse(200, {"integrations": []})
        with mock.patch.object(
            self.admin_app.integrations,
            "list_assistant_integrations",
            return_value=inventory,
        ):
            listed = self.admin_app.team_assistant_integrations("team_1")
        self.assertEqual(json.loads(listed.body), {"integrations": []})
        self.assertEqual(listed.headers["cache-control"], "no-store")

        disconnected = self.admin_app.team.TeamResponse(204, {})
        with mock.patch.object(
            self.admin_app.integrations,
            "disconnect_assistant_integration",
            return_value=disconnected,
        ):
            response = asyncio.run(
                self.admin_app.team_assistant_integration_disconnect(
                    "team_1",
                    "shimpz-cloudflare",
                    "x-integration",
                )
            )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.body, b"")

    def test_authorize_body_must_be_exactly_empty(self) -> None:
        request = _request(
            "POST",
            "http://localhost:7777/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32 + "/authorize",
            body=b'{"client_id":"must-not-cross"}',
            cookie=f"shimpz_admin={self.session}",
        )
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request))
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
