"""The Supervisor's own sign-in security: refused second factors reported after sign-in (ADR-0051)."""

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
from fastapi import HTTPException
from http_request import LOOPBACK, http_request, json_headers
from mfa_helper import NOW, code, configure_supervisor, isolated_store
from starlette.requests import Request
from starlette.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import auth
import state
from mfa import passkeys, totp

PASSWORD = "violet otter lantern quartz 92"
ORIGIN = "http://localhost:7777"
# What the browser marks on every request the Admin page sends to its own origin.
ADMIN_PAGE = ((b"sec-fetch-site", b"same-origin"),)


def _secret() -> str:
    return str(state.get()["totp"]["secret"])


def _failures() -> dict[str, int]:
    return dict(state.get()["second_factor_failures"])


class SecondFactorFailureStateTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)
        configure_supervisor(state, PASSWORD)

    def test_refused_codes_are_reported_by_the_next_sign_in_until_acknowledged(self) -> None:
        later = NOW + 60
        for _attempt in range(totp.FAILURE_LIMIT + 1):
            state.verify_totp("000000", enrollment=False, now=later)
        # The last attempt was refused while locked, unevaluated; it still counts as a refused attempt.
        self.assertEqual(_failures(), {"since_sign_in": totp.FAILURE_LIMIT + 1, "unacknowledged": 0})

        unlocked = later + totp.LOCK_SECONDS
        accepted = state.verify_totp(code(_secret(), unlocked), enrollment=False, now=unlocked, sign_in=True)

        self.assertIs(accepted, totp.Verification.ACCEPTED)
        self.assertEqual(_failures(), {"since_sign_in": 0, "unacknowledged": totp.FAILURE_LIMIT + 1})
        self.assertEqual(state.unacknowledged_second_factor_failures(), totp.FAILURE_LIMIT + 1)
        # A later refusal and sign-in add to what is still unacknowledged.
        state.verify_totp("000000", enrollment=False, now=unlocked + 60)
        state.verify_totp(code(_secret(), unlocked + 90), enrollment=False, now=unlocked + 90, sign_in=True)
        self.assertEqual(state.unacknowledged_second_factor_failures(), totp.FAILURE_LIMIT + 2)

        self.assertEqual(state.acknowledge_second_factor_failures(2), totp.FAILURE_LIMIT)
        self.assertEqual(state.acknowledge_second_factor_failures(totp.FAILURE_LIMIT + 10), 0)

    def test_confirming_an_operation_is_no_sign_in(self) -> None:
        state.verify_totp("000000", enrollment=False, now=NOW + 60)

        state.verify_totp(code(_secret(), NOW + 90), enrollment=False, now=NOW + 90)

        self.assertEqual(_failures(), {"since_sign_in": 1, "unacknowledged": 0})

    def test_a_passkey_sign_in_reports_the_refusals_and_a_passkey_confirmation_does_not(self) -> None:
        record = {
            "credential_id": "credential_A",
            "public_key": "public_key_A",
            "sign_count": 3,
            "backup_eligible": False,
            "backup_state": False,
            "rp_id": "localhost",
            "origin": ORIGIN,
            "status": "active",
            "created_at": NOW,
            "updated_at": NOW,
            "last_used_at": NOW,
        }
        state.add_passkey(record, state.factor_generation())
        state.verify_totp("000000", enrollment=False, now=NOW + 60)
        generation = state.factor_generation()

        original = state.passkey_for_authentication("credential_A", ORIGIN)
        result = passkeys.Authentication("credential_A", 4, False, False)
        state.commit_passkey_authentication(original, result, generation, now=NOW + 61)
        self.assertEqual(_failures(), {"since_sign_in": 1, "unacknowledged": 0})

        original = state.passkey_for_authentication("credential_A", ORIGIN)
        result = passkeys.Authentication("credential_A", 5, False, False)
        state.commit_passkey_authentication(original, result, generation, now=NOW + 62, sign_in=True)
        self.assertEqual(_failures(), {"since_sign_in": 0, "unacknowledged": 1})

    def test_malformed_failure_counters_require_bounded_recovery(self) -> None:
        current = state.get()
        for value in (
            None,
            {"since_sign_in": 0},
            {"since_sign_in": 0, "unacknowledged": True},
            {"since_sign_in": -1, "unacknowledged": 0},
            {"since_sign_in": 0, "unacknowledged": state.MAX_SECOND_FACTOR_FAILURES + 1},
        ):
            with self.subTest(value=value):
                state._write({**current, "second_factor_failures": value})
                self.assertEqual(state.classified_authentication_state(), "recovery-required")

    def test_the_counters_saturate(self) -> None:
        current = state.get()
        maximum = state.MAX_SECOND_FACTOR_FAILURES
        state._write({**current, "second_factor_failures": {"since_sign_in": maximum, "unacknowledged": maximum}})

        state.verify_totp("000000", enrollment=False, now=NOW + 60)
        state.verify_totp(code(_secret(), NOW + 90), enrollment=False, now=NOW + 90, sign_in=True)

        self.assertEqual(_failures(), {"since_sign_in": 0, "unacknowledged": maximum})

    def test_only_a_configured_supervisor_acknowledges(self) -> None:
        isolated_store(self, state)
        state.begin_supervisor_setup(PASSWORD, now=NOW)

        with self.assertRaises(auth.PasswordRecordError):
            state.acknowledge_second_factor_failures(1)


class SecurityRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.key_directory = root / "supervisor"
        cls.key_directory.mkdir(mode=0o2770)
        cls.key_directory.chmod(0o2770)
        cls.admin_app = app_import.load_app(root)
        app_import.replace_for_class(cls, cls.admin_app.state, "STORE_PATH", root / "admin.json")
        app_import.replace_for_class(cls, cls.admin_app.supervisor, "PUBLIC_KEY_FILE", cls.key_directory / "public.pem")

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.audit.path().unlink(missing_ok=True)
        with self.admin_app.state._STORE_LOCK:
            self.admin_app.state._store_cache = None
        self.admin_app.supervisor.PUBLIC_KEY_FILE.unlink(missing_ok=True)
        self.admin_app._LOCAL_AUTH_CONTEXT = self.admin_app.local_auth.Context()
        group = mock.patch.object(
            self.admin_app.supervisor.grp, "getgrnam", return_value=types.SimpleNamespace(gr_gid=os.getgid())
        )
        group.start()
        self.addCleanup(group.stop)

    @staticmethod
    def _request(
        path: str,
        payload: object = None,
        *,
        method: str | None = None,
        cookies: dict[str, str] | None = None,
        origin: str | None = ORIGIN,
    ) -> Request:
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = json_headers(body) if body else []
        if origin is not None:
            headers.append((b"origin", origin.encode("ascii")))
        if cookies:
            headers.append((b"cookie", "; ".join(f"{key}={value}" for key, value in cookies.items()).encode()))
        headers.extend(ADMIN_PAGE)
        return http_request(path, LOOPBACK, method=method or ("POST" if body else "GET"), body=body, headers=headers)

    @staticmethod
    def _cookie(response, name: str) -> str:
        prefix = name + "="
        return next(
            part.removeprefix(prefix) for part in response.headers["set-cookie"].split("; ") if part.startswith(prefix)
        )

    def _sign_in(self) -> str:
        """Set the Supervisor up, then sign in once with a wrong code first; return the session."""
        app = self.admin_app
        setup = asyncio.run(app.admin_setup(self._request("/api/admin/setup", {"password": PASSWORD})))
        secret = json.loads(setup.body)["enrollment"]["secret"]
        ticket = self._cookie(setup, "shimpz_admin_ticket")
        now = int(time.time())
        asyncio.run(
            app.admin_setup_totp(
                self._request(
                    "/api/admin/setup/totp", {"code": code(secret, now)}, cookies={"shimpz_admin_ticket": ticket}
                )
            )
        )
        login = asyncio.run(app.login(self._request("/api/login", {"password": PASSWORD})))
        refused = self._request(
            "/api/login/totp",
            {"code": "000000"},
            cookies={"shimpz_admin_ticket": self._cookie(login, "shimpz_admin_ticket")},
        )
        with self.assertRaises(HTTPException):
            asyncio.run(app.local_login_totp(refused))
        login = asyncio.run(app.login(self._request("/api/login", {"password": PASSWORD})))
        # The next step's code is inside the accepted window and newer than the one setup spent.
        confirmed = asyncio.run(
            app.local_login_totp(
                self._request(
                    "/api/login/totp",
                    {"code": code(secret, now + totp.PERIOD_SECONDS)},
                    cookies={"shimpz_admin_ticket": self._cookie(login, "shimpz_admin_ticket")},
                )
            )
        )
        return self._cookie(confirmed, "shimpz_admin")

    def _gated(self, request: Request):
        """Send one request through the Admin gate to its route, answering a route's refusal as FastAPI does."""
        endpoint = {
            ("GET", "/api/admin/security"): self.admin_app.security.summary,
            ("POST", "/api/admin/security/failures"): self.admin_app.security.acknowledge_failures,
        }[(request.method, request.url.path)]

        async def route(admitted: Request):
            try:
                return await (endpoint(admitted) if admitted.method == "POST" else endpoint())
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

        return asyncio.run(self.admin_app._gate(request, route))

    def test_a_sign_in_reports_the_refused_code_until_the_supervisor_acknowledges_it(self) -> None:
        session = {"shimpz_admin": self._sign_in()}

        summary = self._gated(self._request("/api/admin/security", cookies=session))
        self.assertEqual((summary.status_code, json.loads(summary.body)), (200, {"failed_second_factor_attempts": 1}))
        self.assertEqual(summary.headers["cache-control"], "no-store")

        acknowledged = self._gated(self._request("/api/admin/security/failures", {"acknowledged": 1}, cookies=session))
        self.assertEqual(json.loads(acknowledged.body), {"failed_second_factor_attempts": 0})
        summary = self._gated(self._request("/api/admin/security", cookies=session))
        self.assertEqual(json.loads(summary.body), {"failed_second_factor_attempts": 0})

    def test_the_report_needs_a_session_and_an_acknowledgment_names_a_positive_count(self) -> None:
        self.assertEqual(self._gated(self._request("/api/admin/security")).status_code, 401)
        session = {"shimpz_admin": self._sign_in()}
        for body in (
            {},
            {"acknowledged": 0},
            {"acknowledged": True},
            {"acknowledged": "1"},
            {"acknowledged": 1, "x": 1},
        ):
            with self.subTest(body=body):
                response = self._gated(self._request("/api/admin/security/failures", body, cookies=session))
                self.assertEqual(response.status_code, 400)
        foreign = self._request(
            "/api/admin/security/failures", {"acknowledged": 1}, cookies=session, origin="https://evil.example"
        )
        self.assertEqual(self._gated(foreign).status_code, 403)
        self.assertEqual(self.admin_app.state.unacknowledged_second_factor_failures(), 1)


if __name__ == "__main__":
    unittest.main()
