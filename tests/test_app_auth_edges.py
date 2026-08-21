"""Profile, session, and Supervisor failure edges for the Admin application boundary."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest import mock

from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _request(
    path: str,
    payload: object | None = None,
    *,
    origin: str | None = None,
    cookie: str = "",
) -> Request:
    body = json.dumps(payload).encode() if payload is not None else b""
    headers: list[tuple[bytes, bytes]] = []
    if payload is not None:
        headers.extend(
            [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ]
        )
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookie:
        headers.append((b"cookie", f"shimpz_admin={cookie}".encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("192.0.2.10", 1234),
        "server": ("admin.example.test", 443),
    }
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


class AppAuthenticationEdgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")
        cls.store = root / "admin.json"
        previous_store = cls.admin_app.state.STORE_PATH
        cls.admin_app.state.STORE_PATH = cls.store
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)

    def setUp(self) -> None:
        self.store.unlink(missing_ok=True)
        self.admin_app._LOCAL_AUTH_CONTEXT = self.admin_app.local_auth.Context()

    def assert_status(self, expected: int, awaitable) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            asyncio.run(awaitable)
        self.assertEqual(raised.exception.status_code, expected)

    def test_profile_and_lifespan_reject_drift_and_materialize_initialized_local_authority(self) -> None:
        with (
            mock.patch.dict(os.environ, {"SHIMPZ_ADMIN_PROFILE": "invalid"}),
            self.assertRaisesRegex(RuntimeError, "exactly local or hosted"),
        ):
            self.admin_app.profile.require()

        async def mismatch() -> None:
            with (
                mock.patch.object(self.admin_app.profile, "require", return_value="hosted"),
                self.assertRaisesRegex(RuntimeError, "changed after route registration"),
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    self.fail("profile drift reached the application lifespan")

        async def initialized() -> None:
            with (
                mock.patch.object(self.admin_app.profile, "require", return_value="local"),
                mock.patch.object(self.admin_app.state, "is_initialized", return_value=True),
                mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock()) as to_thread,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass
            to_thread.assert_awaited_once_with(self.admin_app._materialize_local_supervisor)

        async def hosted() -> None:
            with (
                mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
                mock.patch.object(self.admin_app.profile, "require", return_value="hosted"),
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass

        async def uninitialized() -> None:
            with (
                mock.patch.object(self.admin_app.profile, "require", return_value="local"),
                mock.patch.object(self.admin_app.state, "is_initialized", return_value=False),
                mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock()) as to_thread,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass
            to_thread.assert_not_awaited()

        async def recovery_required() -> None:
            error = self.admin_app.auth.PasswordRecordError("corrupt")
            with (
                mock.patch.object(self.admin_app.profile, "require", return_value="local"),
                mock.patch.object(self.admin_app.state, "is_initialized", side_effect=error),
                self.assertLogs("shimpz-admin", level="ERROR") as captured,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass
            self.assertIn("requires bounded recovery", "\n".join(captured.output))

        asyncio.run(mismatch())
        asyncio.run(initialized())
        asyncio.run(hosted())
        asyncio.run(uninitialized())
        asyncio.run(recovery_required())

        identity = object()
        with (
            mock.patch.object(self.admin_app.state, "local_supervisor", return_value=identity),
            mock.patch.object(self.admin_app.supervisor, "materialize_public_key") as materialize,
        ):
            self.admin_app._materialize_local_supervisor()
        materialize.assert_called_once_with(identity)

    def test_origin_helpers_reject_unadmitted_values_and_preserve_an_unchanged_binding(self) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as denied:
            self.admin_app._local_oauth_authorization_mode(
                _request("/authorize", {}, origin="https://unadmitted.example.test")
            )
        self.assertEqual(denied.exception.status_code, 403)

        with mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"):
            self.assertIsNone(self.admin_app._oauth_request_mode(_request("/oauth")))

        with self.assertRaises(self.admin_app.HTTPException) as inexact:
            self.admin_app.local_auth._request_origin(_request("/login", origin="https://EXAMPLE.test"))
        self.assertEqual(inexact.exception.status_code, 403)
        self.assertEqual(
            self.admin_app.local_auth._request_origin(_request("/login", origin="http://localhost:7777")),
            "http://localhost:7777",
        )

        with mock.patch.object(self.admin_app.state, "bind_browser_origin", return_value="unchanged") as bind:
            self.admin_app.local_auth._bind_origin("https://developer.example.test")
        bind.assert_called_once_with("https://developer.example.test")

    def test_oauth_completion_mode_projects_only_the_admin_origin_decision(self) -> None:
        for callback_mode, completion_mode in (
            ("loopback", "automatic"),
            ("hosted", "automatic"),
            ("out-of-band", "code"),
        ):
            with mock.patch.object(
                self.admin_app,
                "_local_oauth_authorization_mode",
                return_value=callback_mode,
            ):
                self.assertEqual(
                    self.admin_app.browser.oauth_completion_mode(
                        _request("/api/session"),
                        self.admin_app._local_oauth_authorization_mode,
                    ),
                    completion_mode,
                )

        unavailable = self.admin_app.HTTPException(status_code=409, detail="unavailable")
        with mock.patch.object(
            self.admin_app,
            "_local_oauth_authorization_mode",
            side_effect=unavailable,
        ):
            self.assertIsNone(
                self.admin_app.browser.oauth_completion_mode(
                    _request("/api/session"),
                    self.admin_app._local_oauth_authorization_mode,
                )
            )

        denied = self.admin_app.HTTPException(status_code=403, detail="denied")
        with (
            mock.patch.object(
                self.admin_app,
                "_local_oauth_authorization_mode",
                side_effect=denied,
            ),
            self.assertRaises(self.admin_app.HTTPException) as caught,
        ):
            self.admin_app.browser.oauth_completion_mode(
                _request("/api/session"),
                self.admin_app._local_oauth_authorization_mode,
            )
        self.assertEqual(caught.exception.status_code, 403)

    def test_session_evidence_maps_corrupt_local_authority_and_hosted_denials(self) -> None:
        authority_error = self.admin_app.supervisor.SupervisorAuthorityError("invalid")
        with (
            mock.patch.object(self.admin_app.state, "authentication_state", return_value="configured"),
            mock.patch.object(self.admin_app.supervisor, "local_session_evidence", side_effect=authority_error),
            self.assertRaises(self.admin_app.SessionEvidenceUnavailableError),
        ):
            self.admin_app._local_session_evidence({})

        unauthorized = self.admin_app.account_identity.AccountResponse(401, {"error": "invalid"})
        inactive = self.admin_app.account_identity.AccountResponse(
            200,
            {"version": 1, "active": False, "account_id": "a" * 32, "supervisor": True},
        )
        with (
            mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
            mock.patch.object(
                self.admin_app.account_identity,
                "run_bounded",
                new=mock.AsyncMock(side_effect=[unauthorized, inactive]),
            ),
        ):
            self.assertIsNone(asyncio.run(self.admin_app._session_evidence({"shimpz_admin": "token"})))
            self.assertIsNone(asyncio.run(self.admin_app._session_evidence({"shimpz_admin": "token"})))

    def test_gate_fails_closed_when_the_team_authority_cannot_be_entered(self) -> None:
        async def should_not_run(_request):
            self.fail("an unavailable Team authority reached the route")

        evidence = {"subject": "supervisor"}
        with (
            mock.patch.object(self.admin_app, "_session_evidence", new=mock.AsyncMock(return_value=evidence)),
            mock.patch.object(
                self.admin_app,
                "_team_session_scope",
                side_effect=self.admin_app.supervisor.SupervisorAuthorityError("unavailable"),
            ),
        ):
            response = asyncio.run(self.admin_app._gate(_request("/api/teams"), should_not_run))
        self.assertEqual(response.status_code, 503)

    def test_password_recovery_is_consistent_across_handler_gate_and_session(self) -> None:
        error = self.admin_app.auth.PasswordRecordError("corrupt")
        handled = asyncio.run(self.admin_app._password_record_unavailable(_request("/api/session"), error))
        self.assertEqual(handled.status_code, 503)
        self.assertEqual(json.loads(handled.body)["code"], "password-recovery-required")

        async def should_not_run(_request):
            self.fail("corrupt Local authentication reached a protected route")

        with mock.patch.object(self.admin_app, "_session_evidence", new=mock.AsyncMock(side_effect=error)):
            gated = asyncio.run(self.admin_app._gate(_request("/api/teams"), should_not_run))
        self.assertEqual(gated.status_code, 503)
        self.assertEqual(json.loads(gated.body)["code"], "password-recovery-required")

        with mock.patch.object(self.admin_app.state, "authentication_state", side_effect=error):
            projected = asyncio.run(self.admin_app.session(_request("/api/session")))
        self.assertEqual(projected["authentication_state"], self.admin_app.auth.RECORD_STATE_RECOVERY_REQUIRED)
        self.assertIs(projected["authenticated"], False)

    def test_local_mfa_and_host_reset_wrappers_preserve_exact_authority(self) -> None:
        request = _request("/api/local-wrapper", {})
        sentinel = object()
        with mock.patch.object(
            self.admin_app.local_auth,
            "confirm_login_passkey",
            new=mock.AsyncMock(return_value=sentinel),
        ) as login_passkey:
            self.assertIs(asyncio.run(self.admin_app.local_login_passkey(request)), sentinel)
        login_passkey.assert_awaited_once_with(request, self.admin_app._LOCAL_AUTH_CONTEXT)

        with mock.patch.object(
            self.admin_app.local_auth,
            "complete_passkey_registration",
            new=mock.AsyncMock(return_value=sentinel),
        ) as complete_registration:
            self.assertIs(asyncio.run(self.admin_app.local_passkey_registration_complete(request)), sentinel)
        complete_registration.assert_awaited_once_with(request, self.admin_app._LOCAL_AUTH_CONTEXT)

        with mock.patch.object(
            self.admin_app.local_auth,
            "_verify_password",
            new=mock.AsyncMock(),
        ) as verify_password:
            asyncio.run(self.admin_app._host_reset_password("secret"))
        verify_password.assert_awaited_once_with("secret", self.admin_app._LOCAL_AUTH_CONTEXT)

        team_response = self.admin_app.JSONResponse({"reset": True})
        with (
            mock.patch.object(self.admin_app, "_team_session_scope", return_value=nullcontext()) as scope,
            mock.patch.object(self.admin_app, "_team_response", return_value=team_response) as response,
        ):
            self.assertIs(self.admin_app._established_host_reset("d" * 64), team_response)
        scope.assert_called_once_with(
            {self.admin_app.COOKIE: "host-reset-v1:" + "d" * 64},
            authority_kind="host-reset",
        )
        response.assert_called_once_with(self.admin_app.team.reset_space)

        with mock.patch.object(
            self.admin_app.host_reset,
            "reset",
            new=mock.AsyncMock(return_value=sentinel),
        ) as reset:
            self.assertIs(asyncio.run(self.admin_app.local_space_host_reset(request)), sentinel)
        reset.assert_awaited_once()
        self.assertIs(reset.await_args.kwargs["setup_lock"], self.admin_app._ADMIN_SETUP_LOCK)
        self.assertIs(reset.await_args.kwargs["verify_password"], self.admin_app._host_reset_password)

    def test_local_login_rejects_invalid_shape_and_missing_initialization(self) -> None:
        self.assert_status(409, self.admin_app.login(_request("/api/login", {"password": "valid-shape"})))
        self.assert_status(400, self.admin_app.admin_setup(_request("/api/admin/setup", {"password": 1})))

    def test_hosted_login_maps_every_upstream_authentication_failure(self) -> None:
        request = _request("/api/login")
        self.assert_status(400, self.admin_app._hosted_login(request, {"username": "only"}))
        self.assert_status(400, self.admin_app._hosted_login(request, {"username": "", "password": "secret"}))

        login = self.admin_app.account_identity.AccountResponse(
            200,
            {"account_id": "a" * 32, "username": "user", "token": "token"},
        )
        cases = (
            ([self.admin_app.account_identity.AccountResponse(401, {"error": "invalid"})], 401),
            ([self.admin_app.account_identity.AccountResponse(503, {"error": "offline"})], 503),
            (
                [
                    login,
                    self.admin_app.account_identity.AccountResponse(503, {"error": "offline"}),
                    self.admin_app.account_identity.AccountResponse(200, {"ok": True}),
                ],
                503,
            ),
        )
        for responses, expected in cases:
            with (
                self.subTest(expected=expected, calls=len(responses)),
                mock.patch.object(
                    self.admin_app.account_identity,
                    "run_bounded",
                    new=mock.AsyncMock(side_effect=responses),
                ),
            ):
                self.assert_status(
                    expected,
                    self.admin_app._hosted_login(request, {"username": "user", "password": "secret"}),
                )

    def test_logout_covers_empty_local_session_and_failed_hosted_revocation(self) -> None:
        local_response = asyncio.run(self.admin_app.logout(_request("/api/logout")))
        self.assertEqual(local_response.status_code, 200)

        with (
            mock.patch.object(self.admin_app, "_allowed_browser_origins", return_value=frozenset()),
            self.assertRaises(self.admin_app.HTTPException) as denied,
        ):
            asyncio.run(
                self.admin_app.logout(_request("/api/logout", origin="https://hostile.example.test", cookie="token"))
            )
        self.assertEqual(denied.exception.status_code, 403)

        with mock.patch.object(
            self.admin_app.state,
            "revoke_sessions_for_logout",
            side_effect=OSError("read-only store"),
        ):
            unavailable = asyncio.run(self.admin_app.logout(_request("/api/logout", cookie="token")))
        self.assertEqual(unavailable.status_code, 503)
        self.assertNotIn("set-cookie", unavailable.headers)

        revoked = self.admin_app.account_identity.AccountResponse(503, {"error": "offline"})
        with (
            mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
            mock.patch.object(
                self.admin_app.account_identity,
                "run_bounded",
                new=mock.AsyncMock(return_value=revoked),
            ),
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "cancel_session"),
        ):
            response = asyncio.run(self.admin_app.logout(_request("/api/logout", cookie="token")))
        self.assertEqual(response.status_code, 503)
        self.assertIn(b"revocation is unavailable", response.body)

    def test_setup_and_reset_reject_invalid_inputs_and_corrupt_password_state(self) -> None:
        self.assert_status(400, self.admin_app.admin_setup(_request("/setup", {"password": 1})))
        for password, code in (
            ("short", "password-too-short"),
            ("x" * (self.admin_app.MAX_PASSWORD_CHARS + 1), "password-too-long"),
            ("correct horse battery staple", "password-blocklisted"),
        ):
            with self.subTest(code=code):
                response = asyncio.run(self.admin_app.admin_setup(_request("/setup", {"password": password})))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(json.loads(response.body)["code"], code)

        self.admin_app.state.begin_supervisor_setup("violet otter lantern quartz 92")
        self.assert_status(
            401,
            self.admin_app.admin_setup(_request("/setup", {"password": "another correct password"})),
        )
        self.assert_status(400, self.admin_app.local_space_reset(_request("/space", {"password": 1})))
        self.assert_status(400, self.admin_app.local_space_reset(_request("/space", {"password": ""})))
        with mock.patch.object(self.admin_app.space_reset.asyncio, "to_thread", side_effect=ValueError("corrupt")):
            self.assert_status(
                503,
                self.admin_app.local_space_reset(_request("/space", {"password": "violet otter lantern quartz 92"})),
            )


if __name__ == "__main__":
    unittest.main()
