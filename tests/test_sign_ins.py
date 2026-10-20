"""A Team's Sign-in through Admin (ADR-0117, 2026-10-20 amendment): exact bodies, exact answers, closed refusals."""

import asyncio
import contextlib
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from mfa import tickets
from session import topics
from team import sign_ins, transport

TRACE = "f" * 32
LONGEST_TEAM_ID = 40
SESSION = "a" * 32
INCARNATION = "c" * 64
SIGN_IN = {
    "sign_in_id": "b" * 32,
    "state": "ready",
    "generation": 1,
    "team_incarnation": INCARNATION,
    "sites": ["example.com"],
    "sites_truncated": False,
    "created_at": "2026-10-19T10:00:00Z",
    "saved_at": "2026-10-19T10:00:00Z",
    "last_used_at": "2026-10-19T10:00:00Z",
    "expires_at": "2026-11-18T10:00:00Z",
}
NAMED = {"sign_in_id": "b" * 32, "generation": 1, "team_incarnation": INCARNATION}
ORIGIN = "https://admin.example"


def traced(body: dict) -> transport.TeamResponse:
    return transport.TeamResponse(200, {**body, "trace_id": TRACE})


class SignInBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.raised: list[str] = []

        def listener(topic: str, _revision: int) -> None:
            self.raised.append(topic)

        topics.listen(listener)
        self.addCleanup(topics.forget, listener)

    def test_each_operation_reaches_its_team_route_and_answers_teams_exact_body_untraced(self) -> None:
        started = {"sign_in_session_id": SESSION, "view_id": "c" * 32, "site": "example.com"}
        cases = (
            (
                sign_ins.start,
                {"url": "https://example.com/login", "locale": "pt", "origin": ORIGIN},
                "sign-in",
                started,
            ),
            (
                sign_ins.save,
                {"sign_in_session_id": SESSION, "origin": ORIGIN},
                "sign-in/save",
                {"sign_in": SIGN_IN, "recorded": True},
            ),
            (sign_ins.cancel, {"sign_in_session_id": SESSION, "origin": ORIGIN}, "sign-in/cancel", {"cancelled": True}),
        )
        for operation, body, route, answer in cases:
            with self.subTest(route=route), mock.patch.object(transport, "call", return_value=traced(answer)) as call:
                response = operation("team_1", body)
            self.assertEqual((response.status, response.body), (200, answer))
            call.assert_called_once_with("POST", f"/v1/teams/team_1/browser/{route}", body)
        with mock.patch.object(transport, "call", return_value=traced({"sign_in": SIGN_IN})) as call:
            response = sign_ins.current("team_1")
        self.assertEqual((response.status, response.body), (200, {"sign_in": SIGN_IN}))
        call.assert_called_once_with("GET", "/v1/teams/team_1/browser/sign-in")
        with mock.patch.object(transport, "call", return_value=traced({"deletion": "pending"})) as call:
            response = sign_ins.delete("team_1", NAMED, "passkey", ORIGIN)
        self.assertEqual((response.status, response.body), (200, {"deletion": "pending"}))
        call.assert_called_once_with(
            "POST", "/v1/teams/team_1/browser/sign-in/delete", {**NAMED, "factor": "passkey", "origin": ORIGIN}
        )
        # A Save, a Cancel, and a deletion change what the Team's Sign-in shows.
        self.assertEqual(self.raised, ["team/team_1/sign-in"] * 3)

    def test_a_deletion_binds_the_exact_sign_in_admin_read(self) -> None:
        subject = sign_ins.deletion_subject("team_1", SIGN_IN)
        self.assertEqual(sign_ins.deletion_subject("team_1", sign_ins.confirmed("b" * 32, "1", INCARNATION)), subject)
        # Every field of the tuple changes the subject, which fits the ticket's bound for the longest Team id.
        for team_id, changed in (
            ("team_2", SIGN_IN),
            ("team_1", {**SIGN_IN, "generation": 2}),
            ("team_1", {**SIGN_IN, "sign_in_id": "d" * 32}),
            ("team_1", {**SIGN_IN, "team_incarnation": "e" * 64}),
        ):
            with self.subTest(team_id=team_id, changed=changed):
                self.assertNotEqual(sign_ins.deletion_subject(team_id, changed), subject)
        longest = sign_ins.deletion_subject("t" * LONGEST_TEAM_ID, {**SIGN_IN, "generation": 2**31 - 1})
        self.assertLessEqual(len(longest), tickets.MAX_SUBJECT_CHARS)
        for named in (
            ("b" * 32, "one", INCARNATION),
            ("b" * 32, "0", INCARNATION),
            ("x", "1", INCARNATION),
            ("b" * 32, 1, INCARNATION),
        ):
            with self.subTest(named=named), self.assertRaises(transport.TeamRequestError):
                sign_ins.confirmed(*named)

    def test_a_body_outside_teams_protocol_never_reaches_team(self) -> None:
        cases = (
            (sign_ins.start, {"url": "http://example.com/", "locale": "en"}),
            (sign_ins.start, {"url": "https://example.com/", "locale": "en", "extra": 1}),
            (sign_ins.save, {"sign_in_session_id": SESSION, "label": "Work"}),
            (sign_ins.cancel, {"sign_in_session_id": "A" * 32}),
        )
        for operation, body in cases:
            with (
                self.subTest(body=body),
                mock.patch.object(transport, "call") as call,
                self.assertRaises(transport.TeamRequestError),
            ):
                operation("team_1", body)
            call.assert_not_called()
        with mock.patch.object(transport, "call") as call, self.assertRaises(transport.TeamRequestError):
            sign_ins.delete("team_1", NAMED, "password", ORIGIN)
        with mock.patch.object(transport, "call") as call, self.assertRaises(transport.TeamRequestError):
            sign_ins.current("Team 1")
        call.assert_not_called()

    def test_only_the_closed_refusals_pass_and_anything_else_is_team_unavailable(self) -> None:
        cases = (
            ((409, {"code": "sign-in-identity-provider", "error": "x"}), (409, "sign-in-identity-provider")),
            ((409, {"code": "sign-in-windows"}), (409, "sign-in-windows")),
            ((409, {"code": "sign-in-busy"}), (409, "sign-in-busy")),
            ((409, {"code": "sign-in-changed"}), (409, "sign-in-changed")),
            ((404, {"code": "sign-in-absent"}), (404, "sign-in-absent")),
            ((404, {"code": "sign-in-not-running"}), (404, "sign-in-not-running")),
            ((503, {"code": "sign-in-unsaved"}), (503, "sign-in-unsaved")),
            ((409, {"code": "sign-in-unsaved"}), (502, None)),
            ((200, {"sign_in": SIGN_IN, "recorded": True}), (502, None)),
            ((200, {"sign_in": SIGN_IN, "recorded": True, "trace_id": "x"}), (502, None)),
            ((200, {"sign_in": {**SIGN_IN, "capsule": "x"}, "recorded": True, "trace_id": TRACE}), (502, None)),
        )
        for (status, answer), (expected, code) in cases:
            with (
                self.subTest(status=status, answer=answer),
                mock.patch.object(transport, "call", return_value=transport.TeamResponse(status, answer)),
            ):
                response = sign_ins.save("team_1", {"sign_in_session_id": SESSION, "origin": ORIGIN})
            self.assertEqual((response.status, response.body.get("code")), (expected, code))
        # A Sign-in that was not saved changes nothing the page shows.
        self.assertEqual(self.raised, [])


STARTED = {"sign_in_session_id": SESSION, "view_id": "c" * 32, "site": "example.com"}
START_BODY = {"url": "https://example.com/", "locale": "en", "origin": ORIGIN}


class RevokedSessionTests(unittest.TestCase):
    """A sign-in session belongs to the Supervisor session that started it: that session's end cancels it."""

    def setUp(self):
        self.addCleanup(sign_ins._RUNNING.clear)
        self.addCleanup(sign_ins._STARTING.clear)
        self.scopes: list[str] = []

    def authority(self, session: str, *, current: bool = True) -> SimpleNamespace:
        @contextlib.contextmanager
        def scope():
            self.scopes.append(session)
            yield

        async def still_current() -> bool:
            return current

        return SimpleNamespace(session=session, scope=scope, current=still_current)

    def cancels(self, action) -> list:
        """The Team calls `action` makes, waiting for the cancel threads it starts."""
        cancelled = transport.TeamResponse(200, {"cancelled": True, "trace_id": TRACE})
        with mock.patch.object(transport, "call", return_value=cancelled) as call:
            action()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and threading.active_count() > self.threads:
                time.sleep(0.01)
        return [entry for entry in call.call_args_list if entry.args[1].endswith("/sign-in/cancel")]

    def start(self, team_id: str, authority, answer=None) -> transport.TeamResponse:
        started = transport.TeamResponse(200, {**STARTED, "trace_id": TRACE}) if answer is None else answer
        with mock.patch.object(transport, "call", return_value=started):
            return sign_ins.start_under(authority, team_id, START_BODY)

    def test_a_started_session_is_cancelled_under_its_authority_when_its_session_ends(self):
        self.threads = threading.active_count()
        self.start("team_1", self.authority("s1"))
        self.start("team_2", self.authority("s2"))
        calls = self.cancels(lambda: sign_ins.sessions_ended(frozenset({"s1"})))
        self.assertEqual(
            [entry.args for entry in calls],
            [("POST", "/v1/teams/team_1/browser/sign-in/cancel", {"sign_in_session_id": SESSION, "origin": ORIGIN})],
        )
        self.assertEqual(self.scopes, ["s1"])
        # Only the very session that finished is forgotten: a stale answer for another one keeps it tracked.
        sign_ins.finished("team_2", "d" * 32)
        self.assertIn("team_2", sign_ins._RUNNING)
        sign_ins.finished("team_2", SESSION)
        self.assertEqual(self.cancels(lambda: sign_ins.sessions_ended(None)), [])

    def test_a_session_revoked_while_its_browser_starts_is_cancelled_once_team_answers(self):
        self.threads = threading.active_count()
        authority = self.authority("s1")

        def started(*_args, **_kwargs):
            # Logout comes while Team starts the Browser.
            sign_ins.sessions_ended(frozenset({"s1"}))
            return transport.TeamResponse(200, {**STARTED, "trace_id": TRACE})

        def action():
            # Another session's start still waiting is left to go on.
            other = sign_ins._Tracked("team_2", self.authority("s2"), ORIGIN)
            sign_ins._STARTING.add(other)
            with mock.patch.object(sign_ins, "start", side_effect=started):
                sign_ins.start_under(authority, "team_1", START_BODY)
            self.assertFalse(other.revoked)
            sign_ins._STARTING.discard(other)

        calls = self.cancels(action)
        self.assertEqual(len(calls), 1)
        self.assertEqual((sign_ins._RUNNING, sign_ins._STARTING), ({}, set()))
        # A start Team refused, or one Admin refused before Team, tracks nothing and keeps the running session's own.
        running = self.authority("s3")
        self.start("team_1", running)
        self.start("team_1", authority, transport.TeamResponse(409, {"code": "browser-busy"}))
        with self.assertRaises(transport.TeamRequestError):
            sign_ins.start_under(authority, "team_1", {"url": "http://example.com/", "locale": "en", "origin": ORIGIN})
        self.assertIs(sign_ins._RUNNING["team_1"].authority, running)
        self.assertEqual(sign_ins._STARTING, set())

    def test_the_sweep_cancels_a_session_whose_authority_lapsed_by_the_full_rule(self):
        self.threads = threading.active_count()
        self.start("team_1", self.authority("s1", current=False))
        self.start("team_2", self.authority("s2"))

        async def one_pass():
            with mock.patch.object(sign_ins, "SWEEP_SECONDS", 0):
                sign_ins.sweep()
                sign_ins.sweep()
                await asyncio.sleep(0.05)
                task = sign_ins._SWEEP[0]
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        calls = self.cancels(lambda: asyncio.run(one_pass()))
        self.assertTrue(calls)
        self.assertTrue(all(entry.args[1] == "/v1/teams/team_1/browser/sign-in/cancel" for entry in calls))

    def test_a_revoked_sessions_cancel_is_asked_again_until_team_takes_it(self):
        tracked = sign_ins._Tracked("team_1", self.authority("s1"), ORIGIN, SESSION)
        answers = [
            transport.TeamResponse(502, {"detail": "team unavailable"}),
            transport.TeamResponse(503, {"code": "browser-unavailable", "trace_id": TRACE}),
        ]
        with (
            mock.patch.object(transport, "call", side_effect=answers) as call,
            mock.patch.object(sign_ins, "CANCEL_RETRY_DELAY_SECONDS", 0),
        ):
            sign_ins._cancel_ended(tracked)
        self.assertEqual(call.call_count, 2)
        # Past Team's own limit, the session surely ended: the last failure is logged and never raised.
        with (
            mock.patch.object(transport, "call", return_value=answers[0]),
            mock.patch.object(sign_ins, "CANCEL_RETRY_SECONDS", 0),
            self.assertLogs("shimpz-admin", "WARNING") as logged,
        ):
            sign_ins._cancel_ended(tracked)
        self.assertIn("could not be cancelled", logged.output[0])


if __name__ == "__main__":
    unittest.main()
