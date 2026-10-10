"""The Supervisor's own sign-in security: refused second factors reported after sign-in (ADR-0051)."""

import asyncio
import hashlib
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
from http_request import LOOPBACK, http_request, json_headers, through_gate
from mfa_helper import NOW, code, configure_supervisor, isolated_store, recovery_codes
from starlette.requests import Request
from starlette.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from mfa import passkeys, recovery, totp
from signin import auth

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
            state.verify_totp("000000", ceremony="operation", now=later)
        # The last attempt was refused while locked, unevaluated; it still counts as a refused attempt.
        self.assertEqual(_failures(), {"since_sign_in": totp.FAILURE_LIMIT + 1, "unacknowledged": 0})

        unlocked = later + totp.LOCK_SECONDS
        accepted = state.verify_totp(code(_secret(), unlocked), ceremony="login", now=unlocked)

        self.assertIs(accepted, totp.Verification.ACCEPTED)
        self.assertEqual(_failures(), {"since_sign_in": 0, "unacknowledged": totp.FAILURE_LIMIT + 1})
        self.assertEqual(state.unacknowledged_second_factor_failures(), totp.FAILURE_LIMIT + 1)
        # A later refusal and sign-in add to what is still unacknowledged.
        state.verify_totp("000000", ceremony="operation", now=unlocked + 60)
        state.verify_totp(code(_secret(), unlocked + 90), ceremony="login", now=unlocked + 90)
        self.assertEqual(state.unacknowledged_second_factor_failures(), totp.FAILURE_LIMIT + 2)

        self.assertEqual(state.acknowledge_second_factor_failures(2), totp.FAILURE_LIMIT)
        self.assertEqual(state.acknowledge_second_factor_failures(totp.FAILURE_LIMIT + 10), 0)

    def test_confirming_an_operation_is_no_sign_in(self) -> None:
        state.verify_totp("000000", ceremony="operation", now=NOW + 60)

        state.verify_totp(code(_secret(), NOW + 90), ceremony="operation", now=NOW + 90)

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
        state.verify_totp("000000", ceremony="operation", now=NOW + 60)
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

        state.verify_totp("000000", ceremony="operation", now=NOW + 60)
        state.verify_totp(code(_secret(), NOW + 90), ceremony="login", now=NOW + 90)

        self.assertEqual(_failures(), {"since_sign_in": 0, "unacknowledged": maximum})

    def test_only_a_configured_supervisor_acknowledges(self) -> None:
        isolated_store(self, state)
        state.begin_supervisor_setup(PASSWORD, now=NOW)

        with self.assertRaises(auth.PasswordRecordError):
            state.acknowledge_second_factor_failures(1)


class RecoveryCodeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)
        configure_supervisor(state, PASSWORD)

    def _spend(self, typed: str, now: int = NOW + 60, generation: int | None = None):
        generation = state.factor_generation() if generation is None else generation
        return state.spend_recovery_code(state.recovery_candidate(typed), generation=generation, now=now)

    def test_a_code_replaces_totp_ends_every_session_and_admits_only_its_re_enrollment(self) -> None:
        before = state.get()
        old_secret = str(before["totp"]["secret"])

        result, enrollment = self._spend(recovery_codes()[0])

        after = state.get()
        self.assertIs(result, totp.Verification.ACCEPTED)
        self.assertNotEqual(enrollment.secret, old_secret)
        self.assertEqual(after["totp"]["status"], "pending")
        self.assertNotEqual(after["session_secret"], before["session_secret"])
        self.assertEqual(after["factor_generation"], before["factor_generation"] + 1)
        self.assertEqual(state.authentication_state(), "recovery-enrollment")
        # Discovery and the release admission see a configured Supervisor, whose way forward is signing in.
        self.assertEqual(state.classified_authentication_state(), "configured")
        with self.assertRaises(totp.TotpStateError):
            state.verify_totp(code(old_secret, NOW + 90), ceremony="login", now=NOW + 90)
        with self.assertRaises(totp.TotpStateError):
            state.recovery_codes_remaining()
        with self.assertRaises(totp.TotpStateError):
            state.replace_recovery_codes(recovery.new_set().record)

        fresh = recovery.new_set()
        accepted = state.verify_totp(
            code(enrollment.secret, NOW + 120), ceremony="recovery", now=NOW + 120, codes=fresh.record
        )
        self.assertIs(accepted, totp.Verification.ACCEPTED)
        self.assertEqual(state.authentication_state(), "configured")
        self.assertEqual(state.recovery_codes_remaining(), recovery.CODE_COUNT)
        # Every code of the earlier set stopped working with it.
        with self.assertRaises(totp.TotpStateError):
            state.verify_totp(
                code(enrollment.secret, NOW + 150), ceremony="recovery", now=NOW + 150, codes=fresh.record
            )
        self.assertIs(self._spend(recovery_codes()[1], NOW + 180)[0], totp.Verification.INVALID)
        self.assertIs(self._spend(fresh.codes[0], NOW + 181)[0], totp.Verification.ACCEPTED)

    def test_another_code_restarts_the_re_enrollment_and_a_spent_code_is_refused(self) -> None:
        first = self._spend(recovery_codes()[0])[1]

        self.assertIs(self._spend(recovery_codes()[0], NOW + 61)[0], totp.Verification.INVALID)
        result, second = self._spend(recovery_codes()[1], NOW + 62)

        self.assertIs(result, totp.Verification.ACCEPTED)
        self.assertNotEqual(second.secret, first.secret)
        self.assertEqual(recovery.remaining(state.get()["recovery_codes"]), recovery.CODE_COUNT - 2)

    def test_refused_codes_spend_the_totp_budget_and_a_lock_refuses_even_a_valid_code(self) -> None:
        for attempt in range(totp.FAILURE_LIMIT - 1):
            self.assertIs(self._spend("0000-0000-0000", NOW + 60 + attempt)[0], totp.Verification.INVALID)
        self.assertIs(self._spend("not a code", NOW + 70)[0], totp.Verification.LOCKED)
        self.assertIs(self._spend(recovery_codes()[0], NOW + 71)[0], totp.Verification.LOCKED)
        # The shared budget also locks TOTP itself.
        locked = state.verify_totp(code(_secret(), NOW + 90), ceremony="login", now=NOW + 90)
        self.assertIs(locked, totp.Verification.LOCKED)
        self.assertEqual(_failures()["since_sign_in"], totp.FAILURE_LIMIT + 2)
        self.assertEqual(recovery.remaining(state.get()["recovery_codes"]), recovery.CODE_COUNT)

        unlocked = NOW + 70 + totp.LOCK_SECONDS
        self.assertIs(self._spend(recovery_codes()[0], unlocked)[0], totp.Verification.ACCEPTED)

    def test_a_ceremony_from_before_a_factor_change_spends_nothing(self) -> None:
        generation = state.factor_generation()
        derived = state.recovery_candidate(recovery_codes()[0])
        state.replace_recovery_codes(recovery.new_set().record)

        self.assertIs(state.spend_recovery_code(derived, generation=generation)[0], totp.Verification.CHANGED)
        stale = state.recovery_candidate(recovery_codes()[0])
        self.assertIs(state.spend_recovery_code(stale, generation=generation)[0], totp.Verification.CHANGED)
        self.assertEqual(state.factor_generation(), generation + 1)

    def test_a_journal_failure_persists_no_spent_code(self) -> None:
        before = state.get()

        def unwritable(_outcome: object) -> None:
            raise OSError("journal unavailable")

        with self.assertRaises(OSError):
            state.spend_recovery_code(
                state.recovery_candidate(recovery_codes()[0]), generation=state.factor_generation(), journal=unwritable
            )
        self.assertEqual(state.get(), before)

    def test_recovery_codes_exist_only_beside_an_enrolled_or_re_enrolling_factor(self) -> None:
        current = state.get()
        for change in (
            lambda data: data.pop("recovery_codes"),
            lambda data: data.update(recovery_codes=None),
            lambda data: data.update(recovery_codes={"salt": "0" * 64, "codes": []}),
        ):
            data = dict(current)
            change(data)
            with self.subTest(codes=repr(data.get("recovery_codes", "missing"))[:30]):
                state._write(data)
                self.assertEqual(state.classified_authentication_state(), "recovery-required")

        isolated_store(self, state)
        state.begin_supervisor_setup(PASSWORD, now=NOW)
        with self.assertRaises(totp.TotpStateError):
            state.recovery_candidate(recovery_codes()[0])
        with self.assertRaises(totp.TotpStateError):
            state.spend_recovery_code(recovery.Candidate("0" * 64, None), generation=state.factor_generation())
        with self.assertRaises(recovery.RecoveryStateError):
            state.verify_totp("000000", ceremony="setup", now=NOW)


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

    def _code(self) -> str:
        """The authenticator's code for the next TOTP step, with Admin's TOTP clock moved onto that step."""
        self.clock[0] += totp.PERIOD_SECONDS
        return code(self.secret, self.clock[0])

    def _call(self, route, path: str, payload: object, **cookies: str):
        """Call one open ceremony route, answering its refusal by status as FastAPI does."""
        try:
            return asyncio.run(route(self._request(path, payload, cookies=cookies)))
        except HTTPException as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    def _login(self) -> tuple[list[str], str]:
        response = self._call(self.admin_app.login, "/api/login", {"password": PASSWORD})
        self.assertEqual(response.status_code, 202)
        return json.loads(response.body)["methods"], self._cookie(response, "shimpz_admin_ticket")

    def _configure(self) -> tuple[str, list[str]]:
        """Set the Supervisor up; return its first session and the recovery codes setup showed."""
        app = self.admin_app
        self.clock = [int(time.time())]
        clock = mock.patch.object(totp, "_timestamp", side_effect=lambda now: self.clock[0] if now is None else now)
        clock.start()
        self.addCleanup(clock.stop)
        setup = self._call(app.admin_setup, "/api/admin/setup", {"password": PASSWORD})
        self.secret = json.loads(setup.body)["enrollment"]["secret"]
        ticket = self._cookie(setup, "shimpz_admin_ticket")
        confirmed = self._call(
            app.admin_setup_totp, "/api/admin/setup/totp", {"code": self._code()}, shimpz_admin_ticket=ticket
        )
        self.assertEqual(confirmed.status_code, 200)
        return self._cookie(confirmed, "shimpz_admin"), json.loads(confirmed.body)["recovery_codes"]

    def _sign_in(self) -> str:
        """Set the Supervisor up, then sign in once with a wrong code first; return the session."""
        app = self.admin_app
        self._configure()
        _methods, ticket = self._login()
        refused = self._call(app.local_login_totp, "/api/login/totp", {"code": "000000"}, shimpz_admin_ticket=ticket)
        self.assertEqual(refused.status_code, 401)
        _methods, ticket = self._login()
        confirmed = self._call(
            app.local_login_totp, "/api/login/totp", {"code": self._code()}, shimpz_admin_ticket=ticket
        )
        return self._cookie(confirmed, "shimpz_admin")

    def _gated(self, request: Request):
        """Send one request through the Admin gate to its route, answering a route's refusal as FastAPI does."""
        app = self.admin_app
        endpoint = {
            ("GET", "/api/admin/security"): app.security.summary,
            ("POST", "/api/admin/security/failures"): app.security.acknowledge_failures,
            ("POST", "/api/admin/recovery-codes/confirmation"): app.recovery_codes_confirmation,
            ("POST", "/api/admin/recovery-codes"): app.recovery_codes_replace,
            ("POST", "/api/admin/supervisor-key/confirmation"): app.supervisor_key_confirmation,
            ("POST", "/api/admin/supervisor-key"): app.supervisor_key_rotate,
        }[(request.method, request.url.path)]

        async def route(admitted: Request):
            try:
                return await endpoint(admitted)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

        return asyncio.run(through_gate(self.admin_app, request, route))

    def _events(self) -> list[tuple[str, str, str | None]]:
        lines = self.admin_app.audit.path().read_text(encoding="utf-8").splitlines()
        return [(entry["event"], entry["outcome"], entry.get("method")) for entry in map(json.loads, lines)]

    def test_a_sign_in_reports_the_refused_code_until_the_supervisor_acknowledges_it(self) -> None:
        session = {"shimpz_admin": self._sign_in()}

        summary = self._gated(self._request("/api/admin/security", cookies=session))
        body = json.loads(summary.body)
        history = body.pop("sign_in_history")
        self.assertEqual(
            (summary.status_code, body), (200, {"failed_second_factor_attempts": 1, "recovery_codes_remaining": 10})
        )
        self.assertEqual(summary.headers["cache-control"], "no-store")
        # The sign-in before this one was the setup, and one code was refused since.
        self.assertEqual((history["previous"]["origin"], history["failures_since"]), (ORIGIN, 1))
        self.assertRegex(history["previous"]["at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

        acknowledged = self._gated(self._request("/api/admin/security/failures", {"acknowledged": 1}, cookies=session))
        self.assertEqual(json.loads(acknowledged.body)["failed_second_factor_attempts"], 0)
        summary = self._gated(self._request("/api/admin/security", cookies=session))
        self.assertEqual(json.loads(summary.body)["failed_second_factor_attempts"], 0)

    def test_an_unreadable_journal_leaves_the_rest_of_the_summary(self) -> None:
        session = {"shimpz_admin": self._sign_in()}
        self.admin_app.audit.path().chmod(0o644)

        summary = self._gated(self._request("/api/admin/security", cookies=session))

        self.assertEqual(json.loads(summary.body)["sign_in_history"], None)
        self.assertEqual(json.loads(summary.body)["recovery_codes_remaining"], recovery.CODE_COUNT)
        with self.assertRaises(HTTPException) as raised:
            self.admin_app.security._history("v3:not-a-session")
        self.assertEqual(raised.exception.status_code, 401)

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

    def test_setup_shows_ten_recovery_codes_once_and_keeps_only_their_digests(self) -> None:
        _session, codes = self._configure()

        self.assertEqual(len(set(codes)), recovery.CODE_COUNT)
        stored = self.admin_app.state.STORE_PATH.read_text(encoding="utf-8")
        self.assertFalse(any(code_ in stored or code_.replace("-", "") in stored for code_ in codes))
        self.assertEqual(self.admin_app.state.recovery_codes_remaining(), recovery.CODE_COUNT)

    def test_a_recovery_code_replaces_totp_and_only_the_re_enrollment_it_admits_signs_in(self) -> None:
        app = self.admin_app
        session, codes = self._configure()
        methods, ticket = self._login()
        self.assertEqual(methods, ["totp", "recovery-code"])
        refused = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": "0000-0000-0000"}, shimpz_admin_ticket=ticket
        )
        self.assertEqual(refused.status_code, 401)

        _methods, ticket = self._login()
        used = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
        )
        self.assertEqual(used.status_code, 202)
        self.assertNotIn("shimpz_admin=", used.headers["set-cookie"])
        self.secret = json.loads(used.body)["enrollment"]["secret"]
        reenrollment = self._cookie(used, "shimpz_admin_ticket")
        # Every session ended, and until TOTP is enrolled again a sign-in offers only another recovery code.
        self.assertEqual(
            self._gated(self._request("/api/admin/security", cookies={"shimpz_admin": session})).status_code, 401
        )
        methods, ticket = self._login()
        self.assertEqual(methods, ["recovery-code"])
        old = self._call(
            app.local_login_totp,
            "/api/login/totp",
            {"code": code(self.secret, self.clock[0])},
            shimpz_admin_ticket=ticket,
        )
        self.assertEqual(old.status_code, 409)

        mistyped = self._call(
            app.local_recovery_enrollment,
            "/api/login/recovery/totp",
            {"code": "000000"},
            shimpz_admin_ticket=reenrollment,
        )
        self.assertEqual(mistyped.status_code, 401)
        reenrollment = self._cookie(mistyped, "shimpz_admin_ticket")
        completed = self._call(
            app.local_recovery_enrollment,
            "/api/login/recovery/totp",
            {"code": self._code()},
            shimpz_admin_ticket=reenrollment,
        )
        self.assertEqual(completed.status_code, 200)
        fresh = json.loads(completed.body)["recovery_codes"]
        self.assertEqual(len(fresh), recovery.CODE_COUNT)
        self.assertFalse(set(fresh) & set(codes))
        new_session = {"shimpz_admin": self._cookie(completed, "shimpz_admin")}
        summary = json.loads(self._gated(self._request("/api/admin/security", cookies=new_session)).body)
        self.assertEqual(summary["failed_second_factor_attempts"], 2)
        self.assertEqual(summary["recovery_codes_remaining"], 10)
        self.assertEqual(summary["sign_in_history"]["failures_since"], 2)
        self.assertEqual(
            [event for event in self._events() if event[0].startswith("recovery")],
            [
                ("recovery-code-rejected", "denied", None),
                ("recovery-code-used", "ok", "recovery-code"),
                ("recovery-completed", "ok", "totp"),
            ],
        )

    def test_a_re_enrollment_belongs_to_the_browser_origin_that_spent_the_code(self) -> None:
        app = self.admin_app
        _session, codes = self._configure()
        _methods, ticket = self._login()
        used = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
        )
        self.secret = json.loads(used.body)["enrollment"]["secret"]
        request = self._request(
            "/api/login/recovery/totp",
            {"code": self._code()},
            cookies={"shimpz_admin_ticket": self._cookie(used, "shimpz_admin_ticket")},
            origin="http://127.0.0.1:7777",
        )

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(app.local_recovery_enrollment(request))
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(app.state.authentication_state(), "recovery-enrollment")

    def test_mistyped_re_enrollment_codes_are_bounded_by_the_new_factor_budget(self) -> None:
        app = self.admin_app
        _session, codes = self._configure()
        _methods, ticket = self._login()
        used = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
        )
        ticket = self._cookie(used, "shimpz_admin_ticket")
        statuses = []
        for _attempt in range(totp.FAILURE_LIMIT):
            refused = self._call(
                app.local_recovery_enrollment,
                "/api/login/recovery/totp",
                {"code": "000000"},
                shimpz_admin_ticket=ticket,
            )
            statuses.append(refused.status_code)
            ticket = self._cookie(refused, "shimpz_admin_ticket") if refused.status_code == 401 else ticket

        self.assertEqual(statuses, [401] * (totp.FAILURE_LIMIT - 1) + [429])
        self.assertNotIn("set-cookie", refused.headers)
        self.assertEqual(app.state.authentication_state(), "recovery-enrollment")

    def test_refused_recovery_codes_lock_with_the_totp_budget(self) -> None:
        app = self.admin_app
        _session, codes = self._configure()
        statuses = []
        for _attempt in range(totp.FAILURE_LIMIT):
            _methods, ticket = self._login()
            refused = self._call(
                app.local_login_recovery, "/api/login/recovery", {"code": "x"}, shimpz_admin_ticket=ticket
            )
            statuses.append(refused.status_code)
        _methods, ticket = self._login()
        locked = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
        )

        self.assertEqual(statuses, [401] * (totp.FAILURE_LIMIT - 1) + [429])
        self.assertEqual(locked.status_code, 429)
        self.assertEqual(app.state.recovery_codes_remaining(), recovery.CODE_COUNT)
        self.assertIn(("recovery-code-locked", "denied", None), self._events())

    def test_a_recovery_code_needs_a_current_password_ticket(self) -> None:
        app = self.admin_app
        _session, codes = self._configure()
        _methods, ticket = self._login()
        app.state.replace_recovery_codes(recovery.new_set().record)

        stale = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
        )
        missing = self._call(app.local_login_recovery, "/api/login/recovery", {"code": codes[0]})
        malformed = self._call(app.local_login_recovery, "/api/login/recovery", {"code": codes[0], "extra": 1})

        self.assertEqual((stale.status_code, missing.status_code, malformed.status_code), (409, 401, 400))

    def test_a_recovery_ceremony_whose_factors_change_meanwhile_spends_nothing(self) -> None:
        app = self.admin_app
        _session, codes = self._configure()
        _methods, ticket = self._login()
        unavailable = mock.patch.object(app.state, "recovery_candidate", side_effect=totp.TotpStateError("changed"))
        with unavailable:
            changed = self._call(
                app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
            )
        _methods, ticket = self._login()
        raced = mock.patch.object(app.state, "spend_recovery_code", return_value=(totp.Verification.CHANGED, None))
        with raced:
            spent = self._call(
                app.local_login_recovery, "/api/login/recovery", {"code": codes[0]}, shimpz_admin_ticket=ticket
            )
        malformed = self._call(app.local_recovery_enrollment, "/api/login/recovery/totp", {"code": "1", "extra": 1})

        self.assertEqual((changed.status_code, spent.status_code, malformed.status_code), (409, 409, 400))
        self.assertEqual(app.state.recovery_codes_remaining(), recovery.CODE_COUNT)

    def test_replacing_the_recovery_codes_needs_the_password_and_a_second_factor(self) -> None:
        app = self.admin_app
        session, codes = self._configure()
        cookies = {"shimpz_admin": session}
        unauthenticated = self._request("/api/admin/recovery-codes/confirmation", {"password": PASSWORD})
        self.assertEqual(self._gated(unauthenticated).status_code, 401)

        def confirmation() -> str:
            offer = self._gated(
                self._request("/api/admin/recovery-codes/confirmation", {"password": PASSWORD}, cookies=cookies)
            )
            self.assertEqual((offer.status_code, json.loads(offer.body)), (202, {"methods": ["totp"]}))
            return self._cookie(offer, "shimpz_admin_ticket")

        wrong = self._gated(
            self._request(
                "/api/admin/recovery-codes",
                {"code": "000000"},
                cookies={**cookies, "shimpz_admin_ticket": confirmation()},
            )
        )
        self.assertEqual((wrong.status_code, json.loads(wrong.body)), (401, {"code": "code-incorrect"}))
        replaced = self._gated(
            self._request(
                "/api/admin/recovery-codes",
                {"code": self._code()},
                cookies={**cookies, "shimpz_admin_ticket": confirmation()},
            )
        )

        self.assertEqual(replaced.status_code, 200)
        self.assertEqual(replaced.headers["cache-control"], "no-store")
        fresh = json.loads(replaced.body)["recovery_codes"]
        self.assertEqual(len(fresh), recovery.CODE_COUNT)
        self.assertFalse(set(fresh) & set(codes))
        _methods, ticket = self._login()
        old = self._call(
            app.local_login_recovery, "/api/login/recovery", {"code": codes[1]}, shimpz_admin_ticket=ticket
        )
        self.assertEqual(old.status_code, 401)
        self.assertIn(("recovery-codes-generated", "ok", None), self._events())
        password = self._gated(
            self._request(
                "/api/admin/recovery-codes/confirmation", {"password": "wrong password value"}, cookies=cookies
            )
        )
        self.assertEqual(json.loads(password.body), {"code": "password-incorrect"})

    def _rotation(self, cookies: dict[str, str], factor: dict[str, str]):
        offer = self._gated(
            self._request("/api/admin/supervisor-key/confirmation", {"password": PASSWORD}, cookies=cookies)
        )
        self.assertEqual((offer.status_code, json.loads(offer.body)), (202, {"methods": ["totp"]}))
        ticket = self._cookie(offer, "shimpz_admin_ticket")
        return self._gated(
            self._request("/api/admin/supervisor-key", factor, cookies={**cookies, "shimpz_admin_ticket": ticket})
        )

    def test_rotating_the_supervisor_key_needs_the_password_and_a_second_factor(self) -> None:
        app = self.admin_app
        session, _codes = self._configure()
        cookies = {"shimpz_admin": session}
        original = app.state.local_supervisor()
        unauthenticated = self._request("/api/admin/supervisor-key/confirmation", {"password": PASSWORD})
        self.assertEqual(self._gated(unauthenticated).status_code, 401)
        team = mock.Mock(return_value=None)

        def pinned(method, path, payload):
            raw = app.supervisor_key.base64.urlsafe_b64decode(payload["public_key"] + "=")
            team(method, path)
            return app.team.TeamResponse(200, {"rotated": True, "key_sha256": hashlib.sha256(raw).hexdigest()})

        with mock.patch.object(app.supervisor_key.transport, "_call", side_effect=pinned):
            wrong = self._rotation(cookies, {"code": "000000"})
            self.assertEqual((wrong.status_code, json.loads(wrong.body)), (401, {"code": "code-incorrect"}))
            team.assert_not_called()
            rotated = self._rotation(cookies, {"code": self._code()})
        self.assertEqual((rotated.status_code, json.loads(rotated.body)), (200, {"rotated": True}))
        self.assertEqual(rotated.headers["cache-control"], "no-store")
        team.assert_called_once_with("POST", "/v1/space/supervisor-key")
        self.assertNotEqual(app.state.local_supervisor(), original)
        # The session stays: the key changes, not the Supervisor.
        self.assertEqual(self._gated(self._request("/api/admin/security", cookies=cookies)).status_code, 200)
        self.assertIn(("supervisor-key-rotated", "ok", None), self._events())

    def test_a_rotation_team_did_not_settle_answers_its_outcome(self) -> None:
        app = self.admin_app
        session, _codes = self._configure()
        cookies = {"shimpz_admin": session}
        retry = mock.Mock()
        app.app.state.supervisor_key_recovery = retry
        self.addCleanup(delattr, app.app.state, "supervisor_key_recovery")
        unavailable = app.team.TeamResponse(502, {"detail": "team unavailable"})
        with mock.patch.object(app.supervisor_key.transport, "_call", return_value=unavailable):
            pending = self._rotation(cookies, {"code": self._code()})
        self.assertEqual(
            (pending.status_code, json.loads(pending.body)), (503, {"code": "supervisor-key-rotation-pending"})
        )
        retry.wake.assert_called_once_with()
        refused = app.team.TeamResponse(403, {"code": "invalid-supervisor"})
        with mock.patch.object(app.supervisor_key.transport, "_call", return_value=refused):
            abandoned = self._rotation(cookies, {"code": self._code()})
        self.assertEqual(
            (abandoned.status_code, json.loads(abandoned.body)), (409, {"code": "supervisor-key-rotation-refused"})
        )
        self.assertIsNone(app.state.pending_supervisor_key())
        with mock.patch.object(app.supervisor_key, "rotate", side_effect=app.state.SupervisorKeyRotationError("x")):
            busy = self._rotation(cookies, {"code": self._code()})
        self.assertEqual((busy.status_code, json.loads(busy.body)), (409, {"code": "supervisor-key-rotation-busy"}))
        with mock.patch.object(app.supervisor_key, "rotate", side_effect=OSError("x")):
            failed = self._rotation(cookies, {"code": self._code()})
        self.assertEqual((failed.status_code, json.loads(failed.body)), (503, {"code": "supervisor-key-unavailable"}))
        password = self._gated(
            self._request(
                "/api/admin/supervisor-key/confirmation", {"password": "wrong password value"}, cookies=cookies
            )
        )
        self.assertEqual(json.loads(password.body), {"code": "password-incorrect"})
        stale = self._gated(self._request("/api/admin/supervisor-key", {"code": "123456"}, cookies=cookies))
        self.assertEqual(json.loads(stale.body), {"code": "authentication-expired"})


if __name__ == "__main__":
    unittest.main()
