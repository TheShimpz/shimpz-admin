"""Session and Supervisor failure edges for the Admin application boundary."""

import asyncio
import json
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest import mock

import app_import
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from http_request import http_request, json_headers, remote


def _request(
    path: str,
    payload: object | None = None,
    *,
    origin: str | None = None,
    cookie: str = "",
) -> Request:
    body = json.dumps(payload).encode() if payload is not None else b""
    headers = json_headers(body) if payload is not None else []
    # The Admin page's own fetch: the browser marks every request it sends to its own origin.
    headers.append((b"sec-fetch-site", b"same-origin"))
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookie:
        headers.append((b"cookie", f"shimpz_admin={cookie}".encode()))
    return http_request(path, remote("192.0.2.10"), body=body, headers=headers)


class AppAuthenticationEdgeTests(app_import.RouteStatusAssertions):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(
            root, extra={"SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777"}
        )
        cls.store = root / "admin.json"
        app_import.replace_for_class(cls, cls.admin_app.state, "STORE_PATH", cls.store)
        app_import.replace_for_class(cls, cls.admin_app.chat_history, "STORE_PATH", root / "chat-history.sqlite3")

    def setUp(self) -> None:
        self.store.unlink(missing_ok=True)
        self.admin_app._LOCAL_AUTH_CONTEXT = self.admin_app.local_auth.Context()

    def test_lifespan_materializes_initialized_local_authority(self) -> None:
        scheduler = mock.patch.object(self.admin_app.routine_scheduler, "RoutineScheduler")

        async def initialized() -> None:
            with (
                mock.patch.object(self.admin_app.state, "is_initialized", return_value=True),
                mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock()) as to_thread,
                scheduler as routines,
                mock.patch.object(self.admin_app.supervisor_key, "Recovery") as recovery,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    # Local runs its Routine scheduler and the retry of an open Supervisor key rotation for exactly
                    # the application's lifetime.
                    routines.return_value.start.assert_called_once_with()
                    routines.return_value.close.assert_not_called()
                    recovery.return_value.start.assert_called_once_with()
                    recovery.return_value.close.assert_not_called()
            to_thread.assert_awaited_once_with(self.admin_app._materialize_local_supervisor)
            routines.return_value.close.assert_called_once_with()
            recovery.return_value.close.assert_called_once_with()

        async def uninitialized() -> None:
            with (
                mock.patch.object(self.admin_app.state, "is_initialized", return_value=False),
                mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock()) as to_thread,
                scheduler,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass
            to_thread.assert_not_awaited()

        async def recovery_required() -> None:
            error = self.admin_app.auth.PasswordRecordError("corrupt")
            with (
                mock.patch.object(self.admin_app.state, "is_initialized", side_effect=error),
                self.assertLogs("shimpz-admin", level="ERROR") as captured,
                scheduler,
            ):
                async with self.admin_app._lifespan(self.admin_app.app):
                    pass
            self.assertIn("requires bounded recovery", "\n".join(captured.output))

        asyncio.run(initialized())
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

        with self.assertRaises(self.admin_app.HTTPException) as inexact:
            self.admin_app.local_auth._request_origin(_request("/login", origin="https://EXAMPLE.test"))
        self.assertEqual(inexact.exception.status_code, 403)
        self.assertEqual(
            self.admin_app.local_auth._request_origin(_request("/login", origin="http://localhost:7777")),
            "http://localhost:7777",
        )

        with (
            mock.patch.object(self.admin_app.state, "bind_browser_origin", return_value="unchanged") as bind,
            self.assertNoLogs("shimpz-admin", level="INFO"),
        ):
            self.admin_app.local_auth._bind_origin("https://developer.example.test")
        bind.assert_called_once_with("https://developer.example.test")
        for transition in ("learned", "replaced"):
            with (
                self.subTest(transition=transition),
                mock.patch.object(self.admin_app.state, "bind_browser_origin", return_value=transition),
                self.assertLogs("shimpz-admin", level="INFO") as captured,
            ):
                self.admin_app.local_auth._bind_origin("https://developer.example.test")
            self.assertEqual(
                [record.getMessage() for record in captured.records],
                [f"Local Admin browser origin {transition} after MFA"],
            )

    def test_oauth_completion_mode_projects_only_the_admin_origin_decision(self) -> None:
        for callback_mode, completion_mode in (
            ("loopback", "automatic"),
            ("local-domain", "automatic"),
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

    def test_session_evidence_maps_corrupt_local_authority(self) -> None:
        authority_error = self.admin_app.supervisor.SupervisorAuthorityError("invalid")
        with (
            mock.patch.object(self.admin_app.state, "authentication_state", return_value="configured"),
            mock.patch.object(self.admin_app.supervisor, "local_session_evidence", side_effect=authority_error),
            self.assertRaises(self.admin_app.SessionEvidenceUnavailableError),
        ):
            self.admin_app._session_evidence({})

    def test_gate_fails_closed_when_the_team_authority_cannot_be_entered(self) -> None:
        async def should_not_run(_request):
            self.fail("an unavailable Team authority reached the route")

        evidence = {"subject": "supervisor"}
        with (
            mock.patch.object(self.admin_app, "_session_evidence", return_value=evidence),
            mock.patch.object(
                self.admin_app,
                "_team_session_scope",
                side_effect=self.admin_app.supervisor.SupervisorAuthorityError("unavailable"),
            ),
        ):
            response = asyncio.run(self.admin_app._gate(_request("/api/teams"), should_not_run))
        self.assertEqual(response.status_code, 503)

    def test_gate_runs_an_authenticated_route_inside_the_supervisor_scope(self) -> None:
        async def route(_request):
            return self.admin_app.JSONResponse({"ok": True})

        evidence = {"subject": "supervisor"}
        with (
            mock.patch.object(self.admin_app, "_session_evidence", return_value=evidence),
            mock.patch.object(self.admin_app, "_team_session_scope", return_value=nullcontext()) as scope,
        ):
            response = asyncio.run(self.admin_app._gate(_request("/api/teams", cookie="token"), route))
        self.assertEqual(response.status_code, 200)
        self.assertIn("Content-Security-Policy", response.headers)
        scope.assert_called_once()

        unavailable = asyncio.run(
            self.admin_app._session_evidence_unavailable(
                _request("/api/session"), self.admin_app.SessionEvidenceUnavailableError()
            )
        )
        self.assertEqual(unavailable.status_code, 503)

    def test_unknown_api_paths_fail_honestly_instead_of_serving_the_shell(self) -> None:
        self.assert_status(404, self.admin_app.unknown_api("retired"))

    def test_password_recovery_is_consistent_across_handler_gate_and_session(self) -> None:
        error = self.admin_app.auth.PasswordRecordError("corrupt")
        handled = asyncio.run(self.admin_app._password_record_unavailable(_request("/api/session"), error))
        self.assertEqual(handled.status_code, 503)
        self.assertEqual(json.loads(handled.body)["code"], "password-recovery-required")

        async def should_not_run(_request):
            self.fail("corrupt Local authentication reached a protected route")

        with mock.patch.object(self.admin_app, "_session_evidence", side_effect=error):
            gated = asyncio.run(self.admin_app._gate(_request("/api/teams"), should_not_run))
        self.assertEqual(gated.status_code, 503)
        self.assertEqual(json.loads(gated.body)["code"], "password-recovery-required")

        with mock.patch.object(
            self.admin_app.state,
            "classified_authentication_state",
            return_value=self.admin_app.auth.RECORD_STATE_RECOVERY_REQUIRED,
        ):
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
            mock.patch.object(self.admin_app, "_space_reset_response", return_value=team_response) as response,
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

    def test_logout_covers_empty_local_session_and_failed_revocation(self) -> None:
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

        with (
            mock.patch.object(self.admin_app.state, "revoke_sessions_for_logout") as revoked,
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "cancel_session") as cancelled,
        ):
            response = asyncio.run(self.admin_app.logout(_request("/api/logout", cookie="token")))
        self.assertEqual(response.status_code, 200)
        revoked.assert_called_once_with("token")
        cancelled.assert_called_once_with("token")

    def test_setup_and_reset_reject_invalid_inputs_and_corrupt_password_state(self) -> None:
        self.assert_status(400, self.admin_app.admin_setup(_request("/setup", {"password": 1})))
        for password, code in (
            ("short", "password-too-short"),
            ("x" * (self.admin_app.MAX_PASSWORD_CHARS + 1), "password-too-long"),
            ("passwordpassword", "password-blocklisted"),
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
        corrupt = mock.AsyncMock(side_effect=self.admin_app.auth.PasswordRecordError("corrupt"))
        with (
            mock.patch.object(self.admin_app.local_auth.auth, "attempt_login", new=corrupt),
            self.assertRaises(self.admin_app.auth.PasswordRecordError),
        ):
            asyncio.run(
                self.admin_app.local_space_reset(_request("/space", {"password": "violet otter lantern quartz 92"}))
            )


if __name__ == "__main__":
    unittest.main()
