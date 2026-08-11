"""Hosted Admin Account-Supervisor authentication contracts."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

ACCOUNT_ID = "a" * 32
SESSION = "a1:" + ACCOUNT_ID + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)
HOSTED_TEAM_RESIDUES = [
    "assistant_containers",
    "brain_checkpoints",
    "cleanup_authority",
    "database",
    "database_role",
    "egress_policies",
    "inference_configuration",
    "integration_credentials",
    "action_checkpoints",
    "publication_bindings",
    "runtime_container",
    "runtime_state",
    "team_networks",
    "team_storage",
    "team_volumes",
]


def _request(
    path: str,
    payload: dict[str, object] | None = None,
    *,
    cookie: str = "",
    scheme: str = "https",
) -> Request:
    body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else b""
    headers = []
    if body:
        headers.extend(
            [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ]
        )
    if cookie:
        headers.append((b"cookie", cookie.encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST" if body else "GET",
        "scheme": scheme,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("192.0.2.1", 1234),
        "server": ("admin.shimpz.test", 443),
    }
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


async def _asgi_request(application, path: str, *, cookie: str = "", method: str = "GET") -> int:
    status, _headers = await _asgi_response(application, path, cookie=cookie, method=method)
    return status


async def _asgi_response(
    application,
    path: str,
    *,
    cookie: str = "",
    method: str = "GET",
) -> tuple[int, dict[str, str]]:
    messages: list[dict] = []
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"cookie", cookie.encode())] if cookie else [],
        "client": ("192.0.2.1", 1234),
        "server": ("admin.shimpz.test", 443),
    }
    await application(scope, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    return start["status"], {key.decode().lower(): value.decode() for key, value in start["headers"]}


class HostedAuthRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        cls.environment = mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_ADMIN_PROFILE": "hosted",
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
            },
        )
        cls.environment.start()
        cls.addClassCleanup(cls.environment.stop)
        sys.modules.pop("app", None)
        cls.admin_app = importlib.import_module("app")

    def test_profile_is_required_and_local_only_routes_are_absent(self) -> None:
        routes = {
            (route.path, method)
            for route in self.admin_app.app.routes
            for method in (getattr(route, "methods", None) or set())
        }

        self.assertEqual(self.admin_app.ADMIN_PROFILE, "hosted")
        self.assertNotIn(("/api/admin/setup", "POST"), routes)
        self.assertFalse(any(path.startswith("/api/model-providers") for path, _method in routes))
        oauth_path = "/api/teams/{team_id}/assistant-integrations/challenges/{challenge_id}"
        self.assertNotIn((oauth_path + "/authorize", "POST"), routes)
        self.assertNotIn((oauth_path + "/complete", "POST"), routes)
        self.assertNotIn((oauth_path + "/authorize", "DELETE"), routes)
        self.assertNotIn("/api/admin/setup", self.admin_app.OPEN_API)
        self.assertEqual(asyncio.run(_asgi_request(self.admin_app.app, "/api/admin/setup")), 401)
        self.assertEqual(asyncio.run(_asgi_request(self.admin_app.app, "/api/model-providers")), 401)
        active = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
        )
        with mock.patch.object(
            self.admin_app.account_identity,
            "run_bounded",
            new=mock.AsyncMock(return_value=active),
        ):
            self.assertEqual(
                asyncio.run(
                    _asgi_request(
                        self.admin_app.app,
                        "/api/model-providers",
                        cookie=f"shimpz_admin={SESSION}",
                    )
                ),
                404,
            )
            concrete_oauth_path = "/api/teams/team_1/assistant-integrations/challenges/" + "a" * 32
            for method, suffix in (("POST", "/authorize"), ("POST", "/complete"), ("DELETE", "/authorize")):
                with self.subTest(method=method, suffix=suffix):
                    self.assertEqual(
                        asyncio.run(
                            _asgi_request(
                                self.admin_app.app,
                                concrete_oauth_path + suffix,
                                cookie=f"shimpz_admin={SESSION}",
                                method=method,
                            )
                        ),
                        404,
                    )

        environment = os.environ.copy()
        environment.pop("SHIMPZ_ADMIN_PROFILE", None)
        result = subprocess.run(
            [sys.executable, "-c", "import app"],
            cwd=BACKEND,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHIMPZ_ADMIN_PROFILE must be exactly local or hosted", result.stderr)

    def test_every_response_suppresses_referrer_metadata(self) -> None:
        # Root exists both with the built SPA and in a clean backend-only checkout.
        status, headers = asyncio.run(_asgi_response(self.admin_app.app, "/"))

        self.assertEqual(status, 200)
        self.assertEqual(headers["referrer-policy"], "no-referrer")

    def test_session_checks_account_online_without_positive_cache(self) -> None:
        active = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
        )
        request = _request("/api/session", cookie=f"shimpz_admin={SESSION}")
        with mock.patch.object(
            self.admin_app.account_identity,
            "run_bounded",
            new=mock.AsyncMock(side_effect=[active, active]),
        ) as run:
            first = asyncio.run(self.admin_app.session(request))
            second = asyncio.run(self.admin_app.session(request))

        self.assertEqual(
            first,
            {
                "profile": "hosted",
                "authenticated": True,
                "account_id": ACCOUNT_ID,
                "features": {"teamCredentials": False},
            },
        )
        self.assertEqual(second, first)
        self.assertEqual(run.await_count, 2)

    def test_authenticated_http_request_binds_the_exact_account_session_to_team(self) -> None:
        active = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
        )
        observed: list[str] = []

        def list_teams():
            observed.append(self.admin_app.team.transport._account_session())
            return self.admin_app.team.TeamResponse(200, {"teams": []})

        with (
            mock.patch.object(
                self.admin_app.account_identity,
                "run_bounded",
                new=mock.AsyncMock(return_value=active),
            ),
            mock.patch.object(self.admin_app.team, "list_teams", side_effect=list_teams),
        ):
            status = asyncio.run(
                _asgi_request(
                    self.admin_app.app,
                    "/api/teams",
                    cookie=f"shimpz_admin={SESSION}",
                )
            )

        self.assertEqual(status, 200)
        self.assertEqual(observed, [SESSION])
        self.assertEqual(self.admin_app.team.transport._account_session(), "")

    def test_account_unavailability_is_not_reported_as_an_invalid_session(self) -> None:
        unavailable = self.admin_app.account_identity.AccountResponse(
            503,
            {"error": "Account identity is busy"},
        )
        with mock.patch.object(
            self.admin_app.account_identity,
            "run_bounded",
            new=mock.AsyncMock(return_value=unavailable),
        ):
            response = asyncio.run(
                _asgi_request(
                    self.admin_app.app,
                    "/api/session",
                    cookie=f"shimpz_admin={SESSION}",
                    method="POST",
                )
            )
        self.assertEqual(response, 503)

    def test_login_admits_only_a_current_supervisor_and_sets_the_account_session(self) -> None:
        login = self.admin_app.account_identity.AccountResponse(
            200,
            {"account_id": ACCOUNT_ID, "username": "supervisor-user", "token": SESSION},
        )
        active = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
        )
        with mock.patch.object(
            self.admin_app.account_identity,
            "run_bounded",
            new=mock.AsyncMock(side_effect=[login, active]),
        ) as run:
            response = asyncio.run(
                self.admin_app.login(
                    _request(
                        "/api/login",
                        {"username": "supervisor-user", "password": "private-password"},
                    )
                )
            )

        self.assertEqual(json.loads(response.body), {"ok": True, "account_id": ACCOUNT_ID})
        self.assertIn("shimpz_admin=", response.headers["set-cookie"])
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("Secure", response.headers["set-cookie"])
        self.assertEqual(run.await_count, 2)

        ordinary = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": False},
        )
        revoked = self.admin_app.account_identity.AccountResponse(200, {"logged_out": True})
        with (
            mock.patch.object(
                self.admin_app.account_identity,
                "run_bounded",
                new=mock.AsyncMock(side_effect=[login, ordinary, revoked]),
            ) as run,
            self.assertRaisesRegex(HTTPException, "Supervisor privilege is required"),
        ):
            asyncio.run(
                self.admin_app.login(
                    _request(
                        "/api/login",
                        {"username": "ordinary-user", "password": "private-password"},
                    )
                )
            )
        self.assertIs(run.await_args_list[2].args[0], self.admin_app.account_identity.logout)
        self.assertEqual(run.await_args_list[2].args[1], SESSION)

    def test_logout_revokes_upstream_before_clearing_the_cookie(self) -> None:
        revoked = self.admin_app.account_identity.AccountResponse(200, {"logged_out": True})
        request = _request("/api/logout", cookie=f"shimpz_admin={SESSION}")
        with mock.patch.object(
            self.admin_app.account_identity,
            "run_bounded",
            new=mock.AsyncMock(return_value=revoked),
        ) as run:
            response = asyncio.run(self.admin_app.logout(request))

        self.assertEqual(response.status_code, 200)
        self.assertRegex(response.headers["set-cookie"], r"shimpz_admin=.*(?:Max-Age=0|01 Jan 1970)")
        run.assert_awaited_once_with(self.admin_app.account_identity.logout, SESSION)

    def test_team_deletion_reauthenticates_the_same_account_session(self) -> None:
        evidence = {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True}
        verified = self.admin_app.account_identity.AccountResponse(
            200,
            {"verified": True, "amr": ["pwd"], "strong_auth_at": 1},
        )
        destroyed = self.admin_app.team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "destroyed": True,
                "assistants_removed": 0,
                "residue_absent": HOSTED_TEAM_RESIDUES,
                "storage_removed": True,
            },
        )

        async def run_inline(function, *args):
            return function(*args)

        request = _request(
            "/api/teams/team_1",
            {"team_name": "Team One", "password": "private-password"},
            cookie=f"shimpz_admin={SESSION}",
        )
        with (
            mock.patch.object(self.admin_app, "_session_evidence", new=mock.AsyncMock(return_value=evidence)),
            mock.patch.object(
                self.admin_app.account_identity,
                "run_bounded",
                new=mock.AsyncMock(return_value=verified),
            ) as run,
            mock.patch.object(self.admin_app.team, "destroy", return_value=destroyed) as destroy,
            mock.patch.object(self.admin_app, "run_in_threadpool", side_effect=run_inline),
        ):
            response = asyncio.run(self.admin_app.teams_destroy("team_1", request))

        self.assertEqual(response.status_code, 200)
        run.assert_awaited_once_with(
            self.admin_app.account_identity.verify_sudo_password,
            SESSION,
            "private-password",
            "192.0.2.1",
        )
        destroy.assert_called_once_with("team_1", "Team One")


if __name__ == "__main__":
    unittest.main()
