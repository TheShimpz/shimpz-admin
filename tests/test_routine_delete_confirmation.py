"""Deleting a Routine needs the Supervisor password and a second factor bound to that exact Routine (ADR-0051)."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from http.cookies import SimpleCookie
from pathlib import Path
from unittest import mock

from mfa_helper import NOW, code, configure_supervisor
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import auth
import local_auth
import state
from mfa import passkeys, tickets, totp
from team import bridge as team

from routine import http as routine_http
from routine import manage

ORIGIN = "http://localhost:7777"
PASSWORD = "a sturdy supervisor passphrase"
TEAM = "team_1"
ROUTINE = "c" * 32
OTHER = "d" * 32
LATER = NOW + 60


def _request(method: str, path: str, payload: object, *, origin: str | None, cookies: dict[str, str]) -> Request:
    body = json.dumps(payload).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookies:
        headers.append((b"cookie", "; ".join(f"{name}={value}" for name, value in cookies.items()).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


class RoutineDeleteConfirmationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        previous = state.STORE_PATH
        state.STORE_PATH = Path(temporary.name) / "admin.json"
        self.addCleanup(setattr, state, "STORE_PATH", previous)
        with state._STORE_LOCK:
            state._store_cache = None
        secret = configure_supervisor(state, PASSWORD)
        # The clock stands just after the fixture's TOTP enrollment, for its codes and the session alike.
        clock = mock.patch.object(totp.time, "time", return_value=LATER)
        clock.start()
        self.addCleanup(clock.stop)
        self.session = auth.issue_session(secret, "totp")
        self.context = local_auth.Context()
        self.begin_route = routine_http.deletion_route(self.context)
        self.delete_route = routine_http.delete_route(self.context)
        self.ticket = ""
        team_delete = mock.patch.object(
            manage,
            "delete",
            return_value=team.TeamResponse(200, {"team_id": TEAM, "routine_id": ROUTINE, "deleted": True}),
        )
        self.team_delete = team_delete.start()
        self.addCleanup(team_delete.stop)

    def _cookies(self) -> dict[str, str]:
        cookies = {local_auth.SESSION_COOKIE: self.session}
        if self.ticket:
            cookies[local_auth.TICKET_COOKIE] = self.ticket
        return cookies

    def begin(self, password: str = PASSWORD, *, routine: str = ROUTINE, origin: str | None = ORIGIN):
        path = f"/api/teams/{TEAM}/routines/{routine}/deletion"
        request = _request("POST", path, {"password": password}, origin=origin, cookies=self._cookies())
        response = asyncio.run(self.begin_route(TEAM, routine, request))
        cookie = SimpleCookie(response.headers.get("set-cookie", ""))
        if local_auth.TICKET_COOKIE in cookie:
            self.ticket = cookie[local_auth.TICKET_COOKIE].value
        return response.status_code, json.loads(response.body), response

    def delete(self, payload: object, *, routine: str = ROUTINE, origin: str | None = ORIGIN):
        path = f"/api/teams/{TEAM}/routines/{routine}"
        request = _request("DELETE", path, payload, origin=origin, cookies=self._cookies())
        response = asyncio.run(self.delete_route(TEAM, routine, request))
        return response.status_code, json.loads(response.body), response

    def code(self, at: int = LATER) -> str:
        return code(state.get()["totp"]["secret"], at)

    def test_password_and_code_bound_to_this_routine_delete_it_once(self) -> None:
        status, body, response = self.begin()
        self.assertEqual((status, body), (202, {"methods": ["totp"]}))
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        set_cookie = response.headers["set-cookie"].lower()
        self.assertIn("httponly", set_cookie)
        self.assertIn("samesite=strict", set_cookie)
        self.team_delete.assert_not_called()

        with self.assertLogs("shimpz-admin", level="INFO") as captured:
            status, body, response = self.delete({"code": self.code()})
        self.assertEqual((status, body), (200, {"team_id": TEAM, "routine_id": ROUTINE, "deleted": True}))
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)
        self.assertIn(f'{local_auth.TICKET_COOKIE}=""', response.headers["set-cookie"])
        logged = " ".join(captured.output)
        self.assertNotIn(PASSWORD, logged)
        self.assertNotIn(self.code(), logged)

        # The ticket is spent: the same proof never deletes again, even with a fresh code.
        status, body, _ = self.delete({"code": self.code(LATER + 30)})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_called_once()

    def test_a_ticket_for_one_routine_never_deletes_another_and_is_burned(self) -> None:
        self.begin(routine=ROUTINE)
        status, body, _ = self.delete({"code": self.code()}, routine=OTHER)
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        status, body, _ = self.delete({"code": self.code()}, routine=ROUTINE)
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_not_called()

    def test_a_login_ticket_is_not_an_operation_ticket_and_the_reverse(self) -> None:
        self.ticket = self.context.ticket_store.issue("login", ORIGIN, state.factor_generation())
        status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        operation = self.context.ticket_store.issue(
            "operation", ORIGIN, state.factor_generation(), manage.deletion_subject(TEAM, ROUTINE)
        )
        with self.assertRaises(tickets.TicketError):
            self.context.ticket_store.consume(operation, "login")
        with self.assertRaises(tickets.TicketError):
            self.context.ticket_store.consume(operation, "operation", manage.deletion_subject(TEAM, ROUTINE))
        self.team_delete.assert_not_called()

    def test_no_ticket_or_a_wrong_code_never_reaches_team(self) -> None:
        status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.begin()
        wrong = f"{(int(self.code()) + 1) % 1_000_000:06d}"
        status, body, _ = self.delete({"code": wrong})
        self.assertEqual((status, body), (401, {"code": "code-incorrect"}))
        # A wrong code spends the ticket, exactly as at sign-in: the password is asked again.
        status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_not_called()

    def test_wrong_passwords_share_the_sign_in_lockout(self) -> None:
        for _attempt in range(auth.LOGIN_FAILURE_LIMIT - 1):
            status, body, _ = self.begin("not the supervisor passphrase")
            self.assertEqual((status, body), (401, {"code": "password-incorrect"}))
        self.assertEqual(self.ticket, "")
        status, body, response = self.begin("not the supervisor passphrase")
        self.assertEqual((status, body["code"]), (429, "authentication-locked"))
        self.assertEqual(body["retry_after"], auth.LOGIN_LOCK_SECONDS)
        self.assertEqual(response.headers["Retry-After"], str(auth.LOGIN_LOCK_SECONDS))
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        # The correct password is locked too, and so is sign-in, which shares the one budget.
        status, body, _ = self.begin()
        self.assertEqual((status, body["code"]), (429, "authentication-locked"))
        login = _request("POST", "/api/login", {"password": PASSWORD}, origin=ORIGIN, cookies={})
        with self.assertRaises(local_auth.HTTPException) as locked:
            asyncio.run(local_auth.login(login, self.context))
        self.assertEqual(locked.exception.status_code, 429)
        self.team_delete.assert_not_called()

    def test_wrong_codes_share_the_durable_totp_lockout(self) -> None:
        wrong = f"{(int(self.code()) + 1) % 1_000_000:06d}"
        for _attempt in range(totp.FAILURE_LIMIT - 1):
            self.begin()
            self.assertEqual(self.delete({"code": wrong})[1], {"code": "code-incorrect"})
        self.begin()
        self.assertEqual(self.delete({"code": wrong})[:2], (429, {"code": "code-locked"}))
        self.begin()
        self.assertEqual(self.delete({"code": self.code()})[:2], (429, {"code": "code-locked"}))
        self.team_delete.assert_not_called()

    def test_an_origin_admin_does_not_already_admit_is_refused_before_the_password(self) -> None:
        for origin in (None, "https://admin.example", "http://evil.example"):
            with self.subTest(origin=origin):
                status, body, _ = self.begin("not the supervisor passphrase", origin=origin)
                self.assertEqual((status, body), (403, {"code": "authentication-origin-refused"}))
        # No rejection was counted: the right password still works afterwards.
        self.assertEqual(self.begin()[0], 202)
        status, body, _ = self.delete({"code": self.code()}, origin="https://admin.example")
        self.assertEqual((status, body), (403, {"code": "authentication-origin-refused"}))
        self.assertEqual(state.browser_origin(), None)
        self.team_delete.assert_not_called()

    def test_changed_factors_or_a_revoked_session_stop_the_deletion(self) -> None:
        self.begin()
        data = state.get()
        state._write({**data, "factor_generation": int(data["factor_generation"]) + 1})
        status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))

        # The TOTP transaction itself checks the ticket's generation: a change there is not a counted failure.
        self.begin()
        generation = state.factor_generation()
        with mock.patch.object(state, "verify_totp", wraps=state.verify_totp) as verify:
            self.delete({"code": self.code()})
        self.assertEqual(verify.call_args.kwargs["generation"], generation)
        before = state.get()["totp"]
        state._write({**state.get(), "factor_generation": generation + 1})
        changed = state.verify_totp(self.code(), enrollment=False, generation=generation)
        self.assertIs(changed, totp.Verification.CHANGED)
        self.assertEqual(state.get()["totp"], before)
        self.team_delete.reset_mock()

        # The session that asked is revoked while the factor is checked: Team is not asked.
        self.begin()
        state._write({**state.get(), "session_secret": auth.new_secret()})
        status, body, _ = self.delete({"code": self.code(LATER + 30)})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_not_called()

    def test_a_session_revoked_while_the_factor_is_checked_never_reaches_team(self) -> None:
        self.begin()
        verify = state.verify_totp

        def accept_then_log_out(*args, **kwargs):
            result = verify(*args, **kwargs)
            state._write({**state.get(), "session_secret": auth.new_secret()})
            return result

        with mock.patch.object(state, "verify_totp", side_effect=accept_then_log_out):
            status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (401, {"code": "authentication-expired"}))
        self.team_delete.assert_not_called()

    def test_authentication_state_failures_are_unavailable_at_every_step(self) -> None:
        def unreadable(*_args, **_kwargs):
            raise OSError("unreadable store")

        with mock.patch.object(state, "authentication_state", side_effect=unreadable):
            status, body, response = self.begin()
        self.assertEqual(
            (status, body, response.headers["Cache-Control"]), (503, {"code": "authentication-unavailable"}, "no-store")
        )
        with (
            mock.patch.object(local_auth, "passkey_registered", return_value=True),
            mock.patch.object(state, "active_passkeys", side_effect=unreadable),
        ):
            status, body, response = self.begin()
        self.assertEqual((status, body), (503, {"code": "authentication-unavailable"}))
        self.assertNotIn("set-cookie", response.headers)

        # Reading the ticket's factor generation, then the session after an accepted code.
        for target, at in (("factor_generation", LATER), ("get", LATER + 30)):
            with self.subTest(target=target):
                self.begin()
                current = self.code(at)
                with (
                    mock.patch.object(local_auth.state, target, side_effect=unreadable),
                    self.assertLogs("shimpz-admin", level="WARNING"),
                ):
                    status, body, response = self.delete({"code": current})
                self.assertEqual(
                    (status, body, response.headers["Cache-Control"]),
                    (503, {"code": "authentication-unavailable"}, "no-store"),
                )
        self.team_delete.assert_not_called()

    def test_verification_failures_and_bad_bodies_fail_closed(self) -> None:
        self.begin()
        with mock.patch.object(state, "verify_totp", side_effect=totp.TotpStateError("broken")):
            status, body, _ = self.delete({"code": self.code()})
        self.assertEqual((status, body), (503, {"code": "authentication-unavailable"}))
        for payload in ({}, {"code": 123456}, {"code": "123456", "credential": {}}, {"password": PASSWORD}):
            with self.subTest(payload=payload):
                self.begin()
                with self.assertRaises(local_auth.HTTPException) as refused:
                    self.delete(payload)
                self.assertEqual(refused.exception.status_code, 400)
                self.assertEqual(refused.exception.headers, {"Cache-Control": "no-store"})
        with mock.patch.object(self.context.ticket_store, "issue", side_effect=tickets.TicketError("full")):
            self.assertEqual(self.begin()[:2], (503, {"code": "authentication-unavailable"}))
        for route in (self.begin_route, self.delete_route):
            with self.subTest(route=route), self.assertRaises(local_auth.HTTPException) as invalid:
                asyncio.run(route(TEAM, "../x", None))
            self.assertEqual(invalid.exception.status_code, 400)
        self.team_delete.assert_not_called()

    def test_a_passkey_confirms_the_deletion_and_a_suspension_refuses_it(self) -> None:
        options = {"challenge": "x"}
        with (
            mock.patch.object(local_auth, "passkey_registered", return_value=True),
            mock.patch.object(state, "active_passkeys", return_value=[{"credential_id": "credential"}]),
            mock.patch.object(passkeys, "authentication_options", return_value=options),
        ):
            status, body, _ = self.begin()
        self.assertEqual((status, body), (202, {"methods": ["totp", "passkey"], "passkey_options": options}))
        with mock.patch.object(local_auth, "_passkey_assertion", return_value=("s" * 64, None)) as assertion:
            status, body, _ = self.delete({"credential": {"id": "credential"}})
        self.assertEqual(status, 200)
        self.assertEqual(assertion.call_args.args[2], {"id": "credential"})
        self.team_delete.assert_called_once_with(TEAM, ROUTINE)

        self.team_delete.reset_mock()
        for outcome, expected in (
            (("s" * 64, "counter-regression"), (401, {"code": "passkey-suspended"})),
            (local_auth.HTTPException(401, "invalid"), (401, {"code": "passkey-failed"})),
            (local_auth.HTTPException(409, "changed"), (401, {"code": "authentication-expired"})),
        ):
            with self.subTest(outcome=outcome):
                with mock.patch.object(local_auth, "passkey_registered", return_value=False):
                    self.begin()
                effect = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                with (
                    mock.patch.object(local_auth, "_passkey_assertion", **effect),
                    mock.patch.object(self.context.ticket_store, "clear") as factor_changed,
                    self.assertNoLogs("shimpz-admin", level="ERROR"),
                ):
                    self.assertEqual(self.delete({"credential": {}})[:2], expected)
                self.assertEqual(factor_changed.called, expected[1]["code"] == "passkey-suspended")
        self.team_delete.assert_not_called()

    def test_a_passkey_challenge_failure_is_unavailable_not_silently_totp_only(self) -> None:
        with (
            mock.patch.object(local_auth, "passkey_registered", return_value=True),
            mock.patch.object(
                self.context.challenge_store, "issue", side_effect=passkeys.PasskeyUnavailableError("capacity")
            ),
        ):
            status, body, response = self.begin()
        self.assertEqual((status, body), (503, {"code": "authentication-unavailable"}))
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self.delete({"code": self.code()})[:2], (401, {"code": "authentication-expired"}))
        self.team_delete.assert_not_called()


class OperationTicketTests(unittest.TestCase):
    def test_operation_tickets_need_a_bounded_subject_and_others_take_none(self) -> None:
        store = tickets.TicketStore()
        for purpose, subject in (
            ("operation", ""),
            ("operation", " padded "),
            ("operation", "x" * (tickets.MAX_SUBJECT_CHARS + 1)),
            ("operation", "é"),
            ("login", "routine-delete:team_1:" + ROUTINE),
        ):
            with self.subTest(purpose=purpose, subject=subject), self.assertRaises(ValueError):
                store.issue(purpose, ORIGIN, 1, subject)
        token = store.issue("operation", ORIGIN, 1, "routine-delete:team_1:" + ROUTINE)
        ticket = store.consume(token, "operation", "routine-delete:team_1:" + ROUTINE)
        self.assertEqual((ticket.purpose, ticket.subject), ("operation", "routine-delete:team_1:" + ROUTINE))

    def test_the_subject_names_the_canonical_team_and_routine(self) -> None:
        self.assertEqual(manage.deletion_subject(TEAM, ROUTINE), f"routine-delete:{TEAM}:{ROUTINE}")
        for team_id, routine_id in (("Team", ROUTINE), (TEAM, "../x"), (TEAM, ROUTINE.upper())):
            with self.subTest(team_id=team_id, routine_id=routine_id), self.assertRaises(team.TeamRequestError):
                manage.deletion_subject(team_id, routine_id)


if __name__ == "__main__":
    unittest.main()
