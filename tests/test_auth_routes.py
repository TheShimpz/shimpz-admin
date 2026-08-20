"""Route-level contracts for the local Admin bootstrap boundary."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

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
                    "/api/oauth/cloudflare/start",
                    "/api/oauth/cloudflare/callback",
                    "/api/space/bootstrap",
                }
            ),
        )
        self.assertFalse(any("/api/teams" in path or "/assistants" in path for path in self.admin_app.OPEN_API))

    def test_bootstrap_reset_open_gate_is_always_no_store(self) -> None:
        async def response(_request):
            return PlainTextResponse("bounded failure", status_code=400)

        result = asyncio.run(
            self.admin_app._gate(
                self._request("/api/space/bootstrap", {}, method="DELETE"),
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
        method: str | None = None,
    ) -> Request:
        raw_path, _, query = path.partition("?")
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())] if body else []
        if origin is not None:
            headers.append((b"origin", origin.encode("ascii")))
        if cookie is not None:
            headers.append((b"cookie", f"shimpz_admin={cookie}".encode("ascii")))
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
        password = "correct horse battery staple"
        with mock.patch.object(self.admin_app.asyncio, "to_thread", wraps=asyncio.to_thread) as to_thread:
            response = asyncio.run(
                self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password}))
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("set-cookie", response.headers)
        self.assertTrue(self.admin_app.state.is_initialized())
        to_thread.assert_awaited_once_with(self.admin_app._initialize_local_supervisor, password, None)

    def test_login_verifies_the_password_off_the_event_loop(self) -> None:
        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))
        record = self.admin_app.state.get()

        with mock.patch.object(self.admin_app.asyncio, "to_thread", wraps=asyncio.to_thread) as to_thread:
            response = asyncio.run(self.admin_app.login(self._request("/api/login", {"password": password})))

        self.assertEqual(response.status_code, 200)
        to_thread.assert_awaited_once_with(
            self.admin_app.auth.verify_password,
            password,
            record["salt"],
            record["password_hash"],
        )

    def test_external_https_origin_is_bound_only_after_correct_password(self) -> None:
        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))

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
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.admin_app.state.browser_origin(), "https://developer.example.test")
        self.assertIn("Secure", response.headers["set-cookie"])

        session_token = self.admin_app.auth.issue_session(self.admin_app.state.get()["session_secret"])
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
        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))

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
        response = asyncio.run(
            self.admin_app.admin_setup(
                self._request(
                    "/api/admin/setup",
                    {"password": "correct horse battery staple"},
                    origin="https://first.example.test",
                )
            )
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.admin_app.state.browser_origin(), "https://first.example.test")
        self.assertIn("Secure", response.headers["set-cookie"])

    def test_forwarded_protocol_cannot_mark_a_loopback_session_secure(self) -> None:
        request = self._request(
            "/api/admin/setup",
            {"password": "correct horse battery staple"},
        )
        request.scope["headers"].append((b"x-forwarded-proto", b"https"))

        response = asyncio.run(self.admin_app.admin_setup(request))

        self.assertNotIn("Secure", response.headers["set-cookie"])

    def test_local_space_reset_requires_password_confirmation_before_team(self) -> None:
        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))
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

    def test_bootstrap_reset_skips_password_only_before_supervisor_setup(self) -> None:
        request = self._request("/api/space/bootstrap", {}, method="DELETE")
        expected = self.admin_app.team.TeamResponse(200, {"reset": True})
        with mock.patch.object(
            self.admin_app.team,
            "bootstrap_reset_space",
            return_value=expected,
        ) as team_reset:
            response = asyncio.run(self.admin_app.local_space_bootstrap_reset(request))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"reset": True})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("set-cookie", response.headers)
        team_reset.assert_called_once_with()

        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))
        with mock.patch.object(self.admin_app.team, "bootstrap_reset_space") as blocked:
            configured = asyncio.run(
                self.admin_app.local_space_bootstrap_reset(self._request("/api/space/bootstrap", {}, method="DELETE"))
            )
        self.assertEqual(configured.status_code, 409)
        self.assertEqual(
            json.loads(configured.body),
            {
                "code": "supervisor-password-required",
                "detail": "Supervisor password is configured",
            },
        )
        blocked.assert_not_called()

    def test_bootstrap_reset_rejects_nonempty_body_before_team_cleanup(self) -> None:
        request = self._request("/api/space/bootstrap", {"unexpected": True}, method="DELETE")

        with (
            mock.patch.object(self.admin_app.team, "bootstrap_reset_space") as blocked,
            self.assertRaises(self.admin_app.HTTPException) as caught,
        ):
            asyncio.run(self.admin_app.local_space_bootstrap_reset(request))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.detail, "request body must be an empty object")
        blocked.assert_not_called()

    def test_bootstrap_reset_fails_closed_while_setup_lock_is_held(self) -> None:
        async def exercise():
            await self.admin_app._ADMIN_SETUP_LOCK.acquire()
            try:
                return await self.admin_app.local_space_bootstrap_reset(
                    self._request("/api/space/bootstrap", {}, method="DELETE")
                )
            finally:
                self.admin_app._ADMIN_SETUP_LOCK.release()

        with mock.patch.object(self.admin_app.team, "bootstrap_reset_space") as blocked:
            response = asyncio.run(exercise())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body)["code"], "bootstrap-reset-busy")
        blocked.assert_not_called()

    def test_bootstrap_reset_releases_setup_lock_after_corrupt_admin_state(self) -> None:
        self.admin_app.state.STORE_PATH.write_text("{", encoding="utf-8")
        request = self._request("/api/space/bootstrap", {}, method="DELETE")

        with (
            mock.patch.object(self.admin_app.team, "bootstrap_reset_space") as blocked,
            self.assertRaisesRegex(RuntimeError, "is corrupt"),
        ):
            asyncio.run(self.admin_app.local_space_bootstrap_reset(request))

        blocked.assert_not_called()
        self.assertFalse(self.admin_app._ADMIN_SETUP_LOCK.locked())

    def test_local_space_reset_bounds_team_request_failure(self) -> None:
        password = "correct horse battery staple"
        asyncio.run(self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password})))
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
