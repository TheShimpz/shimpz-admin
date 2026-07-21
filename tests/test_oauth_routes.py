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


def _request(method: str, url: str, *, body: bytes = b"", cookie: str = "") -> Request:
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
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    def setUp(self) -> None:
        self.admin_app.OAUTH_HANDOFFS = self.admin_app.oauth_handoff.OAuthHandoffStore(
            ttl_seconds=30,
        )
        self.session = "v1:9999999999:0123456789abcdef:" + "a" * 64

    @staticmethod
    def _cloudflare_authorization_url() -> str:
        return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(
            {
                "scope": "dns.read offline_access zone.read",
                "state": "b" * 43,
                "code_challenge": "c" * 43,
            }
        )

    def test_authenticated_post_returns_only_one_strict_loopback_handoff(self) -> None:
        request = _request(
            "POST",
            "http://localhost:7777/api/teams/team_1/assistant-accounts/challenges/" + "a" * 32 + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
        )
        with mock.patch.object(self.admin_app, "_session_ok", return_value=True):
            response = asyncio.run(self.admin_app.team_assistant_account_authorize("team_1", "a" * 32, request))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertEqual(set(body), {"authorization_url"})
        parsed = urlsplit(body["authorization_url"])
        self.assertEqual(
            (parsed.scheme, parsed.hostname, parsed.port, parsed.path, parsed.fragment),
            ("http", "127.0.0.1", 7777, "/api/oauth/cloudflare/start", ""),
        )
        query = parse_qs(parsed.query, strict_parsing=True)
        self.assertEqual(set(query), {"handoff"})
        self.assertRegex(query["handoff"][0], r"^[0-9a-f]{64}$")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_loopback_start_consumes_once_and_sets_browser_only_callback_binding(self) -> None:
        handoff = self.admin_app.OAUTH_HANDOFFS.issue(
            team_id="team_1",
            challenge_id="a" * 32,
            admin_session=self.session,
        )
        request = _request("GET", f"http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff={handoff}")
        result = self.admin_app.teams.DriverResponse(
            200,
            {"authorization_url": self._cloudflare_authorization_url()},
        )
        with mock.patch.object(
            self.admin_app.teams,
            "start_assistant_account_authorization",
            return_value=result,
        ) as start:
            response = asyncio.run(self.admin_app.oauth_cloudflare_start(request, handoff))
            replay = asyncio.run(self.admin_app.oauth_cloudflare_start(request, handoff))

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
        start.assert_called_once_with("team_1", "a" * 32, binding.value)
        self.assertEqual(replay.status_code, 303)
        self.assertEqual(replay.headers["location"], "/chat")

    def test_canary_handoff_start_and_callback_use_only_the_named_https_origin(self) -> None:
        authorize_request = _request(
            "POST",
            "https://local.shimpz.com/api/teams/team_1/assistant-accounts/challenges/" + "a" * 32 + "/authorize",
            body=b"{}",
            cookie=f"shimpz_admin={self.session}",
        )
        with (
            mock.patch.dict(os.environ, {"SHIMPZ_OAUTH_CALLBACK_MODE": "canary"}),
            mock.patch.object(self.admin_app, "_session_ok", return_value=True),
        ):
            authorized = asyncio.run(
                self.admin_app.team_assistant_account_authorize("team_1", "a" * 32, authorize_request)
            )
        authorization_url = urlsplit(json.loads(authorized.body)["authorization_url"])
        self.assertEqual(
            (authorization_url.scheme, authorization_url.netloc, authorization_url.path),
            ("https", "local.shimpz.com", "/api/oauth/cloudflare/start"),
        )

        handoff = parse_qs(authorization_url.query, strict_parsing=True)["handoff"][0]
        start_request = _request("GET", authorization_url.geturl())
        provider = self.admin_app.teams.DriverResponse(200, {"authorization_url": self._cloudflare_authorization_url()})
        with (
            mock.patch.dict(os.environ, {"SHIMPZ_OAUTH_CALLBACK_MODE": "canary"}),
            mock.patch.object(self.admin_app.teams, "start_assistant_account_authorization", return_value=provider),
        ):
            started = asyncio.run(self.admin_app.oauth_cloudflare_start(start_request, handoff))
        cookie = SimpleCookie()
        cookie.load(started.headers["set-cookie"])
        binding = cookie["shimpz_oauth_binding"]
        self.assertEqual(started.status_code, 303)
        self.assertTrue(binding["secure"])

        callback = _request(
            "GET",
            "https://local.shimpz.com/api/oauth/cloudflare/callback?state=" + "b" * 43 + "&claim=" + "a" * 64,
            cookie=f"shimpz_oauth_binding={binding.value}",
        )
        completed = self.admin_app.teams.DriverResponse(200, {"connected": True})
        with (
            mock.patch.dict(os.environ, {"SHIMPZ_OAUTH_CALLBACK_MODE": "canary"}),
            mock.patch.object(
                self.admin_app.teams,
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
            with mock.patch.dict(os.environ, {"SHIMPZ_OAUTH_CALLBACK_MODE": "canary"}):
                result = asyncio.run(self.admin_app.oauth_cloudflare_start(rejected, "f" * 64))
            self.assertEqual(result.headers["location"], "/chat")

    def test_callback_forwards_exact_proof_then_removes_it_from_the_browser_url(self) -> None:
        binding = "d" * 43
        state = "b" * 43
        claim = "a" * 64
        request = _request(
            "GET",
            f"http://127.0.0.1:7777/api/oauth/cloudflare/callback?state={state}&claim={claim}",
            cookie=f"shimpz_oauth_binding={binding}",
        )
        result = self.admin_app.teams.DriverResponse(
            200,
            {
                "connected": True,
                "team_id": "team_1",
                "assistant_id": "shimpz-assistant",
                "account_id": "x-account",
            },
        )
        with mock.patch.object(
            self.admin_app.teams,
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
        with mock.patch.object(self.admin_app.teams, "complete_cloudflare_oauth_callback") as complete:
            responses = [asyncio.run(self.admin_app.oauth_cloudflare_callback(request)) for request in requests]
        complete.assert_not_called()
        self.assertTrue(all(response.headers["location"] == "/chat" for response in responses))

    def test_inventory_and_disconnect_keep_the_public_contract_exact(self) -> None:
        inventory = self.admin_app.teams.DriverResponse(200, {"accounts": []})
        with mock.patch.object(
            self.admin_app.teams,
            "list_assistant_accounts",
            return_value=inventory,
        ):
            listed = self.admin_app.team_assistant_accounts("team_1")
        self.assertEqual(json.loads(listed.body), {"accounts": []})
        self.assertEqual(listed.headers["cache-control"], "no-store")

        disconnected = self.admin_app.teams.DriverResponse(204, {})
        with mock.patch.object(
            self.admin_app.teams,
            "disconnect_assistant_account",
            return_value=disconnected,
        ):
            response = asyncio.run(
                self.admin_app.team_assistant_account_disconnect(
                    "team_1",
                    "shimpz-assistant",
                    "x-account",
                )
            )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.body, b"")

    def test_authorize_body_must_be_exactly_empty(self) -> None:
        request = _request(
            "POST",
            "http://localhost:7777/api/teams/team_1/assistant-accounts/challenges/" + "a" * 32 + "/authorize",
            body=b'{"client_id":"must-not-cross"}',
            cookie=f"shimpz_admin={self.session}",
        )
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(self.admin_app.team_assistant_account_authorize("team_1", "a" * 32, request))
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
