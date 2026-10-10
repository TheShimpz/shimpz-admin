"""Route-level contracts for the local Admin bootstrap boundary."""

import asyncio
import json
import os
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import LOOPBACK, http_request, json_headers
from mfa_helper import code, configure_supervisor
from starlette.requests import Request
from starlette.responses import PlainTextResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class AuthRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.key_directory = root / "supervisor"
        cls.key_directory.mkdir(mode=0o2770)
        cls.key_directory.chmod(0o2770)
        cls.admin_app = app_import.load_app(
            root,
            extra={
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        )
        app_import.replace_for_class(cls, cls.admin_app.state, "STORE_PATH", root / "admin.json")
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
        background: bool = False,
    ) -> Request:
        raw_path, _, query = path.partition("?")
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = json_headers(body) if body else []
        if origin is not None:
            headers.append((b"origin", origin.encode("ascii")))
        if cookie is not None:
            headers.append((b"cookie", f"shimpz_admin={cookie}".encode("ascii")))
        if ticket is not None:
            headers.append((b"cookie", f"shimpz_admin_ticket={ticket}".encode("ascii")))
        if background:
            headers.append((b"shimpz-activity", b"background"))
        return http_request(
            raw_path,
            LOOPBACK,
            method=method or ("POST" if body else "GET"),
            body=body,
            headers=headers,
            query=query.encode(),
        )

    @staticmethod
    def _cookie(response, name: str) -> str:
        prefix = name + "="
        return next(
            part.removeprefix(prefix) for part in response.headers["set-cookie"].split("; ") if part.startswith(prefix)
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

    def test_a_valid_session_in_the_query_grants_no_api_access(self) -> None:
        _setup, confirmed = self._configure("violet otter lantern quartz 92")
        session = self._cookie(confirmed, "shimpz_admin")

        async def allowed(_request):
            return PlainTextResponse("allowed")

        with_cookie = asyncio.run(self.admin_app._gate(self._request("/api/model-providers", cookie=session), allowed))
        self.assertEqual(with_cookie.status_code, 200)

        async def should_not_run(_request):
            self.fail("a session in the query reached a session-gated endpoint")

        for query in (f"shimpz_admin={session}", f"token={session}"):
            with self.subTest(query=query.partition("=")[0]):
                guarded = asyncio.run(
                    self.admin_app._gate(self._request(f"/api/model-providers?{query}"), should_not_run)
                )
                self.assertEqual(guarded.status_code, 401)
                self.assertNotIn("set-cookie", guarded.headers)

    def test_background_refreshes_never_keep_an_idle_session_alive(self) -> None:
        auth = self.admin_app.auth
        now = [0.0]

        async def allowed(_request):
            return PlainTextResponse("allowed")

        def status(session: str, *, background: bool) -> int:
            request = self._request("/api/model-providers", cookie=session, background=background)
            return asyncio.run(self.admin_app._gate(request, allowed)).status_code

        with mock.patch.object(auth, "SESSIONS", auth.SessionActivity(clock=lambda: now[0])):
            _setup, confirmed = self._configure("violet otter lantern quartz 92")
            polled = self._cookie(confirmed, "shimpz_admin")
            attended = auth.issue_session(self.admin_app.state.get()["session_secret"], "totp")
            now[0] = auth.IDLE_SECONDS - 600
            self.assertEqual((status(polled, background=True), status(attended, background=False)), (200, 200))
            now[0] = auth.IDLE_SECONDS + 1
            self.assertEqual(status(polled, background=True), 401)
            self.assertEqual(status(attended, background=True), 200)
            now[0] = 2 * auth.IDLE_SECONDS
            self.assertEqual(status(attended, background=False), 401)

    def test_a_session_this_process_does_not_track_is_refused(self) -> None:
        _setup, confirmed = self._configure("violet otter lantern quartz 92")
        session = self._cookie(confirmed, "shimpz_admin")
        auth = self.admin_app.auth

        async def allowed(_request):
            return PlainTextResponse("allowed")

        # A restarted Admin, or one that evicted the session, has no record of its activity: sign in again.
        with mock.patch.object(auth, "SESSIONS", auth.SessionActivity()):
            response = asyncio.run(self.admin_app._gate(self._request("/api/model-providers", cookie=session), allowed))
        self.assertEqual(response.status_code, 401)

    def test_password_setup_runs_off_the_event_loop(self) -> None:
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

    def _journal(self) -> list[str]:
        journal = self.admin_app.audit.path()
        lines = journal.read_text(encoding="ascii").splitlines() if journal.exists() else []
        return [json.loads(line)["event"] for line in lines]

    def test_a_cross_origin_state_change_never_reaches_its_route(self) -> None:
        session = self._cookie(self._configure("violet otter lantern quartz 92")[1], "shimpz_admin")

        async def route(_request):
            return PlainTextResponse("changed")

        def answer(origin: str):
            request = self._request("/api/model-providers/openai", {"api_key": "x"}, origin=origin, cookie=session)
            request.scope["method"] = "PUT"
            return asyncio.run(self.admin_app._gate(request, route))

        refused = answer("http://127.0.0.1:5173")
        self.assertEqual((refused.status_code, refused.headers["cache-control"]), (403, "no-store"))
        self.assertEqual(json.loads(refused.body), {"detail": "browser origin is not admitted"})
        self.assertEqual(answer("http://127.0.0.1:7777").status_code, 200)

    def test_logout_journals_the_session_it_ends(self) -> None:
        session = self._cookie(self._configure("violet otter lantern quartz 92")[1], "shimpz_admin")
        response = asyncio.run(
            self.admin_app.logout(self._request("/api/logout", origin="http://127.0.0.1:7777", cookie=session))
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._journal()[-1], "logout")
        self.assertIsNone(self.admin_app._session_evidence({"shimpz_admin": session}))

    def test_password_rechecks_share_the_sign_in_budget_and_lockout(self) -> None:
        password = "violet otter lantern quartz 92"
        session = self._cookie(self._configure(password)[1], "shimpz_admin")
        limit = self.admin_app.auth.LOGIN_FAILURE_LIMIT

        def team_deletion(attempt: str) -> int:
            request = self._request(
                "/api/teams/marketing", {"team_name": "Marketing", "password": attempt}, cookie=session
            )
            request.scope["method"] = "DELETE"
            with self.assertRaises(self.admin_app.HTTPException) as refused:
                asyncio.run(self.admin_app.teams_destroy("marketing", request))
            return refused.exception.status_code

        with mock.patch.object(self.admin_app.team, "destroy_confirmed") as destroyed:
            self.assertEqual([team_deletion("definitely wrong") for _ in range(limit)], [403] * (limit - 1) + [429])
        destroyed.assert_not_called()
        # The lock is sign-in's own: neither another recheck nor a sign-in may guess while it lasts.
        reset = self._request("/api/space", {"password": password}, cookie=session)
        reset.scope["method"] = "DELETE"
        with self.assertRaises(self.admin_app.HTTPException) as locked:
            asyncio.run(self.admin_app.local_space_reset(reset))
        self.assertEqual((locked.exception.status_code, locked.exception.headers["Retry-After"]), (429, "60"))
        with self.assertRaises(self.admin_app.HTTPException) as login:
            asyncio.run(self.admin_app.login(self._request("/api/login", {"password": password})))
        self.assertEqual(login.exception.status_code, 429)
        self.assertEqual(self._journal()[-limit:], ["password-rejected"] * (limit - 1) + ["password-locked"])

    def test_an_unwritable_journal_answers_unavailable_and_is_never_cached(self) -> None:
        error = self.admin_app.audit.AuditUnavailableError("unwritable")
        with self.assertLogs("shimpz-admin", "ERROR"):
            response = asyncio.run(self.admin_app._audit_unavailable(self._request("/api/login"), error))
        self.assertEqual((response.status_code, response.headers["cache-control"]), (503, "no-store"))
        self.assertEqual(json.loads(response.body), {"detail": "Supervisor authentication audit is unavailable"})

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
