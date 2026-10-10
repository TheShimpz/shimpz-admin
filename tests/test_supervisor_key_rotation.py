"""Rotating the Supervisor's signing key under the key Team pins now (ADR-0051, ADR-0017)."""

import hashlib
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from mfa_helper import configure_supervisor, isolated_store

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
import supervisor
from signin import audit
from space import supervisor_key
from team import transport

PASSWORD = "violet otter lantern quartz 92"
SESSION = "session-value"


class _Team:
    """Team's pin of the Supervisor key: it verifies each rotation under the key it pins now, as Team does."""

    def __init__(self, pinned: str, *, unavailable: int = 0) -> None:
        self.pinned = pinned
        self.unavailable = unavailable
        self.signers: list[str] = []
        self.authorities: list[str] = []

    def __call__(self, method: str, path: str, payload: dict[str, object]) -> transport.TeamResponse:
        assert (method, path) == ("POST", supervisor_key.ROTATION_PATH)
        session = transport._SUPERVISOR_SESSION.get()
        signer = _digest(session.local_identity)
        self.signers.append(signer)
        self.authorities.append(session.value)
        if self.unavailable:
            self.unavailable -= 1
            return transport.TeamResponse(502, {"detail": "team unavailable"})
        if signer != self.pinned:
            return transport.TeamResponse(403, {"code": "invalid-supervisor"})
        raw = supervisor_key.base64.urlsafe_b64decode(payload["public_key"] + "=")
        self.pinned = hashlib.sha256(raw).hexdigest()
        return transport.TeamResponse(200, {"rotated": True, "key_sha256": self.pinned, "trace_id": "a" * 32})


def _digest(identity: supervisor.LocalIdentity) -> str:
    return hashlib.sha256(supervisor.public_key_raw(identity)).hexdigest()


def _events() -> list[tuple[str, str]]:
    lines = audit.path().read_text(encoding="utf-8").splitlines()
    return [(entry["event"], entry["outcome"]) for entry in map(json.loads, lines)]


class SupervisorKeyRotationTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)
        configure_supervisor(state, PASSWORD)
        self.original = state.local_supervisor()
        published = mock.patch.object(supervisor, "materialize_public_key")
        self.published = published.start()
        self.addCleanup(published.stop)

    def _team(self, team: _Team):
        return mock.patch.object(transport, "_call", side_effect=team)

    def _assert_kept(self) -> None:
        self.assertEqual(state.local_supervisor(), self.original)
        self.assertIsNone(state.pending_supervisor_key())

    def test_team_switching_makes_the_new_key_current_publishes_it_and_drops_the_old_one(self) -> None:
        team = _Team(_digest(self.original))
        with self._team(team):
            outcome = supervisor_key.rotate(SESSION, "http://localhost:7777")
        self.assertIs(outcome, supervisor_key.Outcome.ROTATED)
        current = state.local_supervisor()
        self.assertEqual(current.supervisor_id, self.original.supervisor_id)
        self.assertNotEqual(current.private_key_hex, self.original.private_key_hex)
        self.assertEqual(team.pinned, _digest(current))
        self.assertNotIn(self.original.private_key_hex, json.dumps(state.get()))
        self.assertIsNone(state.pending_supervisor_key())
        self.published.assert_called_once_with(current)
        # Signed once, by the key Team pinned, under the Supervisor's own session.
        self.assertEqual((team.signers, team.authorities), ([_digest(self.original)], [SESSION]))
        self.assertEqual(_events()[-2:], [("supervisor-key-rotation-started", "ok"), ("supervisor-key-rotated", "ok")])

    def test_a_restart_after_team_switched_completes_with_the_new_key(self) -> None:
        # Admin saved the pending key and Team switched, but Admin stopped before it made the new key current.
        pending = supervisor.LocalIdentity(self.original.supervisor_id, supervisor.new_identity().private_key_hex)
        state.begin_supervisor_key_rotation(pending)
        team = _Team(_digest(pending))
        with self._team(team):
            self.assertIs(supervisor_key.resolve(), supervisor_key.Outcome.ROTATED)
        self.assertEqual(state.local_supervisor(), pending)
        self.assertEqual(team.signers, [_digest(self.original), _digest(pending)])
        # Without a session the retry signs under a fresh one-time value, never a stored secret.
        self.assertEqual(len(set(team.authorities)), 1)
        self.assertNotIn(team.authorities[0], json.dumps(state.get()))

    def test_a_restart_before_team_heard_of_the_rotation_sends_it_under_the_old_key(self) -> None:
        pending = supervisor.LocalIdentity(self.original.supervisor_id, supervisor.new_identity().private_key_hex)
        state.begin_supervisor_key_rotation(pending)
        team = _Team(_digest(self.original))
        with self._team(team):
            self.assertIs(supervisor_key.resolve(), supervisor_key.Outcome.ROTATED)
        self.assertEqual(state.local_supervisor(), pending)
        self.assertEqual(team.signers, [_digest(self.original)])

    def test_team_refusing_both_keys_keeps_the_old_key_and_clears_the_pending_one(self) -> None:
        for status in (403, 409):
            with self.subTest(status=status):
                answers = [transport.TeamResponse(status, {}), transport.TeamResponse(403, {})]
                with mock.patch.object(transport, "_call", side_effect=answers):
                    self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.ABANDONED)
                self._assert_kept()
        self.assertEqual(_events()[-1], ("supervisor-key-rotation-abandoned", "denied"))
        # Any other definite refusal under the old key means Team never switched: the new key is not tried.
        with mock.patch.object(transport, "_call", return_value=transport.TeamResponse(400, {})) as call:
            self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.ABANDONED)
        call.assert_called_once()
        self._assert_kept()
        self.published.assert_not_called()

    def test_an_unanswered_rotation_keeps_both_keys_until_a_retry_settles_it(self) -> None:
        cases = (
            [transport.TeamResponse(502, {"detail": "team unavailable"})],
            [transport.TeamResponse(403, {}), transport.TeamResponse(503, {})],
            # Team switched to another key than this one: keep both rather than guess which one it pins.
            [transport.TeamResponse(200, {"rotated": True, "key_sha256": "0" * 64})],
        )
        for answers in cases:
            with self.subTest(answers=answers), self.assertLogs("shimpz-admin", "WARNING"):
                with mock.patch.object(transport, "_call", side_effect=answers):
                    self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.PENDING)
                pending = state.pending_supervisor_key()
                self.assertIsNotNone(pending)
                self.assertEqual(state.local_supervisor(), self.original)
                # The open rotation is settled before another begins: Team kept the old key.
                with mock.patch.object(transport, "_call", side_effect=_Team("f" * 64)):
                    self.assertIs(supervisor_key.resolve(), supervisor_key.Outcome.ABANDONED)
                self._assert_kept()

    def test_a_rotation_asked_for_while_one_is_open_settles_that_one(self) -> None:
        team = _Team(_digest(self.original), unavailable=1)
        with self._team(team), self.assertLogs("shimpz-admin", "WARNING"):
            self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.PENDING)
        pending = state.pending_supervisor_key()
        with self._team(team):
            self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.ROTATED)
        # The open rotation's key is the one adopted; no second key was generated.
        self.assertEqual(state.local_supervisor(), pending)
        with self._team(_Team("f" * 64)):
            self.assertIs(supervisor_key.resolve(), supervisor_key.Outcome.NONE)

    def test_a_journal_refusal_persists_nothing_and_a_retry_completes(self) -> None:
        team = _Team(_digest(self.original))
        with (
            self._team(team),
            mock.patch.object(audit, "record", side_effect=audit.AuditUnavailableError("x")),
            self.assertRaises(audit.AuditUnavailableError),
        ):
            supervisor_key.rotate(SESSION, None)
        self.assertIsNone(state.pending_supervisor_key())
        self.assertEqual(team.signers, [])

        pending = supervisor.LocalIdentity(self.original.supervisor_id, supervisor.new_identity().private_key_hex)
        state.begin_supervisor_key_rotation(pending)

        def refuse_adoption(event: str, **_fields: object) -> None:
            if event == "supervisor-key-rotated":
                raise audit.AuditUnavailableError("x")

        with (
            self._team(team),
            mock.patch.object(audit, "record", side_effect=refuse_adoption),
            self.assertRaises(audit.AuditUnavailableError),
        ):
            supervisor_key.resolve()
        # Team switched, but Admin kept both keys; the next attempt finds Team on the new one and adopts it.
        self.assertEqual(state.local_supervisor(), self.original)
        self.assertEqual(state.pending_supervisor_key(), pending)
        with self._team(team):
            self.assertIs(supervisor_key.resolve(), supervisor_key.Outcome.ROTATED)
        self.assertEqual(state.local_supervisor(), pending)

    def test_a_key_that_cannot_be_published_still_completes_the_rotation(self) -> None:
        self.published.side_effect = supervisor.SupervisorAuthorityError("volume unavailable")
        with self._team(_Team(_digest(self.original))), self.assertLogs("shimpz-admin", "WARNING"):
            self.assertIs(supervisor_key.rotate(SESSION, None), supervisor_key.Outcome.ROTATED)
        self.assertNotEqual(state.local_supervisor(), self.original)


class PendingKeyStateTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)

    def test_a_rotation_begins_only_for_a_configured_supervisor_with_another_key(self) -> None:
        identity = supervisor.new_identity()
        with self.assertRaises(supervisor.SupervisorAuthorityError):
            state.begin_supervisor_key_rotation(identity)
        configure_supervisor(state, PASSWORD)
        current = state.local_supervisor()
        other = supervisor.LocalIdentity(current.supervisor_id, supervisor.new_identity().private_key_hex)
        for refused in (current, supervisor.new_identity()):
            with self.subTest(refused=refused), self.assertRaises(state.SupervisorKeyRotationError):
                state.begin_supervisor_key_rotation(refused)
        state.begin_supervisor_key_rotation(other)
        with self.assertRaises(state.SupervisorKeyRotationError):
            state.begin_supervisor_key_rotation(
                supervisor.LocalIdentity(current.supervisor_id, supervisor.new_identity().private_key_hex)
            )
        stranger = supervisor.LocalIdentity(current.supervisor_id, supervisor.new_identity().private_key_hex)
        for settle in (state.adopt_supervisor_key, state.abandon_supervisor_key):
            with self.subTest(settle=settle), self.assertRaises(state.SupervisorKeyRotationError):
                settle(stranger)
        self.assertEqual(state.pending_supervisor_key(), other)

    def test_a_damaged_pending_key_is_unavailable(self) -> None:
        configure_supervisor(state, PASSWORD)
        data = state.get()
        for value in ("zz", data["supervisor_signing_key"]):
            with self.subTest(value=value):
                state._write({**data, state.PENDING_KEY_FIELD: value})
                with self.assertRaises(supervisor.SupervisorAuthorityError):
                    state.pending_supervisor_key()


class RecoveryTests(unittest.TestCase):
    def test_the_retry_runs_at_start_when_woken_and_survives_a_failure(self) -> None:
        calls: list[int] = []
        done = threading.Event()

        def resolve() -> supervisor_key.Outcome:
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("store unreadable")
            done.set()
            return supervisor_key.Outcome.NONE

        recovery = supervisor_key.Recovery(interval=60)
        with mock.patch.object(supervisor_key, "resolve", side_effect=resolve), self.assertLogs("shimpz-admin"):
            recovery.start()
            deadline = time.monotonic() + 5
            while not calls and time.monotonic() < deadline:
                time.sleep(0.01)
            recovery.wake()
            self.assertTrue(done.wait(5))
            recovery.close()
        self.assertEqual(len(calls), 2)
        self.assertFalse(recovery._thread.is_alive())


if __name__ == "__main__":
    unittest.main()
