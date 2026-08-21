"""Route-level contracts for the local Admin bootstrap boundary."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from mfa_helper import code, configure_supervisor
from starlette.requests import Request
from starlette.responses import PlainTextResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class AuthRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        root = Path(cls.tempdir.name)
        cls.key_directory = root / "supervisor"
        cls.key_directory.mkdir(mode=0o2770)
        cls.key_directory.chmod(0o2770)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
                "SHIMPZ_SETUP_TOKEN": "retired-token-must-be-inert",
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")
        previous_store = cls.admin_app.state.STORE_PATH
        cls.admin_app.state.STORE_PATH = root / "admin.json"
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        previous_public_key = cls.admin_app.supervisor.PUBLIC_KEY_FILE
        cls.admin_app.supervisor.PUBLIC_KEY_FILE = cls.key_directory / "public.pem"
        cls.addClassCleanup(
            setattr,
            cls.admin_app.supervisor,
            "PUBLIC_KEY_FILE",
            previous_public_key,
        )

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.supervisor.PUBLIC_KEY_FILE.unlink(missing_ok=True)
        self.admin_app._LOCAL_AUTH_CONTEXT = self.admin_app.local_auth.Context()
        group = mock.patch.object(
            self.admin_app.supervisor.grp,
            "getgrnam",
            return_value=types.SimpleNamespace(gr_gid=os.getgid()),
        )
        group.start()
        self.addCleanup(group.stop)

    def test_open_api_is_the_exact_reviewed_auth_surface(self) -> None:
        self.assertEqual(
            self.admin_app.OPEN_API,
            frozenset(
                {
                    "/api/session",
                    "/api/login",
                    "/api/logout",
                    "/api/admin/setup",
                    "/api/admin/setup/totp",
                    "/api/login/totp",
                    "/api/login/passkey",
                    "/api/oauth/cloudflare/start",
                    "/api/oauth/cloudflare/callback",
                    "/api/space/host",
                }
            ),
        )
        self.assertFalse(any("/api/teams" in path or "/assistants" in path for path in self.admin_app.OPEN_API))

    def test_host_reset_open_gate_is_always_no_store(self) -> None:
        async def response(_request):
            return PlainTextResponse("bounded failure", status_code=400)

        result = asyncio.run(
            self.admin_app._gate(
                self._request("/api/space/host", {}, method="DELETE"),
                response,
            )
        )

        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertNotIn("vary", result.headers)

    @staticmethod
    def _request(
        path: str,
        payload: dict[str, object] | None = None,
        *,
        origin: str | None = None,
        cookie: str | None = None,
        ticket: str | None = None,
        method: str | None = None,
    ) -> Request:
        raw_path, _, query = path.partition("?")
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())] if body else []
        if origin is not None:
            headers.append((b"origin", origin.encode("ascii")))
        if cookie is not None:
            headers.append((b"cookie", f"shimpz_admin={cookie}".encode("ascii")))
        if ticket is not None:
            headers.append((b"cookie", f"shimpz_admin_ticket={ticket}".encode("ascii")))
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method or ("POST" if body else "GET"),
            "scheme": "http",
            "path": raw_path,
            "raw_path": raw_path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        return Request(scope, receive)

    @staticmethod
    def _cookie(response, name: str) -> str:
        prefix = name + "="
        return next(
            part.removeprefix(prefix)
            for part in response.headers["set-cookie"].split("; ")
            if part.startswith(prefix)
        )

    def _configure(self, password: str, origin: str | None = None):
        setup = asyncio.run(
            self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password}, origin=origin))
        )
        enrollment = json.loads(setup.body)["enrollment"]
        ticket = self._cookie(setup, "shimpz_admin_ticket")
        confirmed = asyncio.run(
            self.admin_app.admin_setup_totp(
                self._request(
                    "/api/admin/setup/totp",
                    {"code": code(enrollment["secret"], int(time.time()))},
                    origin=origin,
                    ticket=ticket,
                )
            )
        )
        return setup, confirmed

    def test_retired_query_token_grants_no_session_or_api_access(self) -> None:
        async def serve_static(_request):
            return PlainTextResponse("spa")

        response = asyncio.run(self.admin_app._gate(self._request("/?token=retired-token-must-be-inert"), serve_static))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b"spa")
        self.assertNotIn("set-cookie", response.headers)

        async def should_not_run(_request):
            self.fail("a query token reached a session-gated endpoint")

        guarded = asyncio.run(
            self.admin_app._gate(
                self._request("/api/model-providers?token=retired-token-must-be-inert"),
                should_not_run,
            )
        )
        self.assertEqual(guarded.status_code, 401)
        self.assertFalse(self.admin_app.state.is_initialized())

    def test_retired_environment_does_not_change_password_setup(self) -> None:
        password = "violet otter lantern quartz 92"
        with mock.patch.object(self.admin_app.asyncio, "to_thread", wraps=asyncio.to_thread) as to_thread:
            response = asyncio.run(
                self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password}))
            )

        self.assertEqual(response.status_code, 202)
        self.assertIn("set-cookie", response.headers)
        self.assertTrue(self.admin_app.state.is_initialized())
        self.assertEqual(self.admin_app.state.authentication_state(), "enrollment-required")
        self.assertTrue(
            any(call.args[0] is self.admin_app.state.begin_supervisor_setup for call in to_thread.await_args_list)
        )

    def test_login_verifies_the_password_off_the_event_loop(self) -> None:
        password = "violet otter lantern quartz 92"
        self._configure(password)
        record = self.admin_app.state.get()

        with mock.patch.object(self.admin_app.auth.asyncio, "to_thread", wraps=asyncio.to_thread) as to_thread:
            response = asyncio.run(self.admin_app.login(self._request("/api/login", {"password": password})))

        self.assertEqual(response.status_code, 202)
        to_thread.assert_awaited_once_with(
            self.admin_app.auth.verify_password,
            password,
            record,
        )

    def test_login_degrades_to_totp_when_passkey_options_are_unavailable(self) -> None:
        password = "violet otter lantern quartz 92"
        self._configure(password, "http://localhost:7777")
        with (
            mock.patch.object(self.admin_app.state, "active_passkeys", return_value=[{"credential_id": "one"}]),
            mock.patch.object(
                self.admin_app._LOCAL_AUTH_CONTEXT.challenge_store,
                "issue",
                side_effect=self.admin_app.local_auth.passkeys.PasskeyUnavailableError("capacity reached"),
            ),
        ):
            response = asyncio.run(
                self.admin_app.login(
                    self._request(
                        "/api/login",
                        {"password": password},
                        origin="http://localhost:7777",
                    )
                )
            )

        self.assertEqual(json.loads(response.body), {"methods": ["totp"]})

    def test_passkey_registration_capacity_is_a_conflict_not_server_error(self) -> None:
        configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        session = self.admin_app.auth.issue_session(self.admin_app.state.get()["session_secret"], "totp")
        request = self._request(
            "/api/admin/passkeys/registration",
            {},
            origin="http://localhost:7777",
            cookie=session,
        )
        unavailable = self.admin_app.local_auth.passkeys.PasskeyUnavailableError("maximum passkey count reached")

        with (
            mock.patch.object(self.admin_app.state, "passkeys_for_registration", side_effect=unavailable),
            self.assertRaises(self.admin_app.HTTPException) as raised,
        ):
            asyncio.run(self.admin_app.local_passkey_registration_begin(request))

        self.assertEqual(raised.exception.status_code, 409)

    def test_in_flight_login_returns_one_second_retry_without_consuming_a_rejection(self) -> None:
        password = "violet otter lantern quartz 92"
        self._configure(password)
        self.admin_app._LOCAL_AUTH_CONTEXT.limiter.begin()
        try:
            with self.assertRaises(self.admin_app.HTTPException) as raised:
                asyncio.run(self.admin_app.login(self._request("/api/login", {"password": password})))
        finally:
            self.admin_app._LOCAL_AUTH_CONTEXT.limiter.finish(rejected=None)

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.headers, {"Retry-After": "1"})
        response = asyncio.run(self.admin_app.login(self._request("/api/login", {"password": password})))
        self.assertEqual(response.status_code, 202)

    def test_external_https_origin_is_bound_only_after_correct_password(self) -> None:
        password = "violet otter lantern quartz 92"
        self._configure(password)

        wrong = self._request(
            "/api/login",
            {"password": "definitely wrong"},
            origin="https://developer.example.test",
        )
        with self.assertRaises(self.admin_app.HTTPException) as caught:
            asyncio.run(self.admin_app.login(wrong))
        self.assertEqual(caught.exception.status_code, 401)
        self.assertIsNone(self.admin_app.state.browser_origin())

        valid = self._request(
            "/api/login",
            {"password": password},
            origin="https://developer.example.test",
        )
        response = asyncio.run(self.admin_app.login(valid))
        self.assertEqual(response.status_code, 202)
        self.assertIsNone(self.admin_app.state.browser_origin())
        ticket = self._cookie(response, "shimpz_admin_ticket")
        confirmed = asyncio.run(
            self.admin_app.local_login_totp(
                self._request(
                    "/api/login/totp",
                    {"code": code(self.admin_app.state.get()["totp"]["secret"], int(time.time()) + 30)},
                    origin="https://developer.example.test",
                    ticket=ticket,
                )
            )
        )
        self.assertEqual(self.admin_app.state.browser_origin(), "https://developer.example.test")
        self.assertIn("Secure", confirmed.headers["set-cookie"])

        session_token = self.admin_app.auth.issue_session(self.admin_app.state.get()["session_secret"], "totp")
        admitted = asyncio.run(
            self.admin_app.session(
                self._request("/api/session", origin="https://developer.example.test", cookie=session_token)
            )
        )
        stale = asyncio.run(
            self.admin_app.session(
                self._request("/api/session", origin="https://previous.example.test", cookie=session_token)
            )
        )
        loopback = asyncio.run(
            self.admin_app.session(self._request("/api/session", origin="http://127.0.0.1:7777", cookie=session_token))
        )
        self.assertIs(admitted["origin_admitted"], True)
        self.assertEqual(admitted["oauth_completion_mode"], "code")
        self.assertIs(stale["origin_admitted"], False)
        self.assertNotIn("oauth_completion_mode", stale)
        self.assertIs(loopback["origin_admitted"], True)
        self.assertEqual(loopback["oauth_completion_mode"], "automatic")

    def test_external_origin_is_validated_before_password_verification(self) -> None:
        password = "violet otter lantern quartz 92"
        self._configure(password)

        with (
            self.assertRaises(self.admin_app.HTTPException) as caught,
            mock.patch.object(self.admin_app.auth, "verify_password") as verify_password,
        ):
            asyncio.run(
                self.admin_app.login(
                    self._request(
                        "/api/login",
                        {"password": password},
                        origin="http://developer.example.test",
                    )
                )
            )
        self.assertEqual(caught.exception.status_code, 403)
        verify_password.assert_not_called()

    def test_first_setup_binds_its_external_https_origin(self) -> None:
        _setup, response = self._configure("violet otter lantern quartz 92", "https://first.example.test")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.admin_app.state.browser_origin(), "https://first.example.test")
        self.assertIn("Secure", response.headers["set-cookie"])

    def test_forwarded_protocol_cannot_mark_a_loopback_session_secure(self) -> None:
        request = self._request(
            "/api/admin/setup",
            {"password": "violet otter lantern quartz 92"},
        )
        request.scope["headers"].append((b"x-forwarded-proto", b"https"))

        response = asyncio.run(self.admin_app.admin_setup(request))

        self.assertNotIn("Secure", response.headers["set-cookie"])

    def test_local_space_reset_requires_password_confirmation_before_team(self) -> None:
        password = "violet otter lantern quartz 92"
        configure_supervisor(self.admin_app.state, password)
        reset = self._request("/api/space", {"password": password})
        reset.scope["method"] = "DELETE"
        expected = self.admin_app.team.TeamResponse(200, {"reset": True})

        with mock.patch.object(self.admin_app.team, "reset_space", return_value=expected) as team_reset:
            response = asyncio.run(self.admin_app.local_space_reset(reset))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"reset": True})
        team_reset.assert_called_once_with()

        wrong = self._request("/api/space", {"password": "definitely wrong"})
        wrong.scope["method"] = "DELETE"
        with (
            self.assertRaises(self.admin_app.HTTPException) as caught,
            mock.patch.object(self.admin_app.team, "reset_space") as blocked,
        ):
            asyncio.run(self.admin_app.local_space_reset(wrong))
        self.assertEqual(caught.exception.status_code, 403)
        blocked.assert_not_called()

    def test_local_space_reset_bounds_team_request_failure(self) -> None:
        password = "violet otter lantern quartz 92"
        configure_supervisor(self.admin_app.state, password)
        reset = self._request("/api/space", {"password": password})
        reset.scope["method"] = "DELETE"

        with (
            self.assertRaises(self.admin_app.HTTPException) as caught,
            mock.patch.object(
                self.admin_app.team,
                "reset_space",
                side_effect=self.admin_app.team.TeamRequestError("Supervisor session is unavailable"),
            ),
        ):
            asyncio.run(self.admin_app.local_space_reset(reset))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.detail, "Supervisor session is unavailable")


if __name__ == "__main__":
    unittest.main()
