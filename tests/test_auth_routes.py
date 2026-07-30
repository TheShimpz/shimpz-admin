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
                }
            ),
        )
        self.assertFalse(any("/api/teams" in path or "/assistants" in path for path in self.admin_app.OPEN_API))

    @staticmethod
    def _request(path: str, payload: dict[str, object] | None = None) -> Request:
        raw_path, _, query = path.partition("?")
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = (
            [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())] if body else []
        )
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST" if body else "GET",
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
        to_thread.assert_awaited_once_with(self.admin_app._initialize_local_supervisor, password)

    def test_login_verifies_the_password_off_the_event_loop(self) -> None:
        password = "correct horse battery staple"
        asyncio.run(
            self.admin_app.admin_setup(self._request("/api/admin/setup", {"password": password}))
        )
        record = self.admin_app.state.get()

        with mock.patch.object(self.admin_app.asyncio, "to_thread", wraps=asyncio.to_thread) as to_thread:
            response = asyncio.run(
                self.admin_app.login(self._request("/api/login", {"password": password}))
            )

        self.assertEqual(response.status_code, 200)
        to_thread.assert_awaited_once_with(
            self.admin_app.auth.verify_password,
            password,
            record["salt"],
            record["password_hash"],
        )


if __name__ == "__main__":
    unittest.main()
