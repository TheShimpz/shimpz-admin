"""The durable Supervisor authentication journal: metadata only, bounded, and fail-closed."""

import calendar
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import state
from admin_http import AdminHTTPServer, request, session_cookie, ticket_cookie
from mfa_helper import code, isolated_store
from signin import audit

PASSWORD = "violet otter lantern quartz 92"
EXTERNAL = "https://admin.example.test"


def _events(journal: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in journal.read_text(encoding="ascii").splitlines()]


class JournalTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)
        failure = mock.patch.object(audit, "_failure", None)
        failure.start()
        self.addCleanup(failure.stop)
        self.journal = audit.path()

    def test_an_event_is_one_private_metadata_line(self) -> None:
        audit.record("login", outcome="ok", origin=EXTERNAL, method="totp")
        audit.record("password-rejected", outcome="denied")

        (login, rejected) = _events(self.journal)
        self.assertEqual(set(login), {"ts", "event", "outcome", "origin", "method"})
        self.assertEqual(
            (login["event"], login["outcome"], login["origin"], login["method"]), ("login", "ok", EXTERNAL, "totp")
        )
        self.assertEqual(
            rejected | {"ts": None}, {"ts": None, "event": "password-rejected", "outcome": "denied", "origin": None}
        )
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)

    def test_only_closed_metadata_is_admitted(self) -> None:
        for event, options in (
            ("password-accepted", {"outcome": "ok"}),
            ("login", {"outcome": "maybe"}),
            ("login", {"outcome": "ok", "origin": "HTTPS://ADMIN.EXAMPLE.TEST"}),
            ("login", {"outcome": "ok", "method": "password"}),
        ):
            with self.subTest(event=event, options=options), self.assertRaises(ValueError):
                audit.record(event, **options)
        self.assertFalse(self.journal.exists())

    def test_a_full_journal_rotates_into_bounded_backups(self) -> None:
        with mock.patch.object(audit, "MAX_BYTES", 300):
            for _ in range(12):
                audit.record("password-rejected", outcome="denied")
        backups = sorted(path.name for path in self.journal.parent.glob(f"{audit.FILE_NAME}.*"))
        self.assertEqual(backups, [f"{audit.FILE_NAME}.1", f"{audit.FILE_NAME}.2"])
        for path in (self.journal, *self.journal.parent.glob(f"{audit.FILE_NAME}.*")):
            self.assertLessEqual(path.stat().st_size, 300)

    def test_an_unsafe_backup_refuses_rotation(self) -> None:
        backup = self.journal.with_name(f"{audit.FILE_NAME}.1")
        backup.write_text("", encoding="ascii")
        backup.chmod(0o644)
        with mock.patch.object(audit, "MAX_BYTES", 120):
            audit.record("password-rejected", outcome="denied")
            with self.assertRaises(audit.AuditUnavailableError):
                audit.record("password-rejected", outcome="denied")
        self.assertEqual(len(_events(self.journal)), 1)
        self.assertEqual(backup.read_text(encoding="ascii"), "")

    def test_a_failure_refuses_every_later_event_until_restart(self) -> None:
        self.journal.write_text("", encoding="ascii")
        self.journal.chmod(0o644)
        with self.assertRaises(audit.AuditUnavailableError):
            audit.record("logout", outcome="ok")
        self.journal.chmod(0o600)
        with self.assertRaises(audit.AuditUnavailableError):
            audit.record("logout", outcome="ok")
        self.assertEqual(self.journal.read_text(encoding="ascii"), "")


class AuthenticationAuditHTTPTests(unittest.TestCase):
    def test_ceremonies_are_journaled_without_secrets_and_an_unwritable_journal_refuses_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            journal = root / audit.FILE_NAME
            with AdminHTTPServer(root) as server:
                port = server.port
                status, payload, set_cookie = request(port, "POST", "/api/admin/setup", {"password": PASSWORD})
                secret = payload["enrollment"]["secret"]
                setup_code = code(secret, int(time.time()))
                status, _, set_cookie = request(
                    port,
                    "POST",
                    "/api/admin/setup/totp",
                    {"code": setup_code},
                    session=f"shimpz_admin_ticket={ticket_cookie(set_cookie)}",
                )
                first_session = session_cookie(set_cookie)
                self.assertEqual(status, 200)
                self.assertEqual(request(port, "POST", "/api/login", {"password": "definitely wrong"})[0], 401)
                status, _, _ = request(port, "POST", "/api/logout", session=first_session)
                self.assertEqual(status, 200)

                self.assertEqual(
                    [(event["event"], event["outcome"], event.get("method")) for event in _events(journal)],
                    [
                        ("setup-started", "ok", None),
                        ("setup-completed", "ok", "totp"),
                        ("password-rejected", "denied", None),
                        ("logout", "ok", None),
                    ],
                )
                written = journal.read_text(encoding="ascii")
                for secret_text in (PASSWORD, "definitely wrong", secret, setup_code, first_session):
                    self.assertNotIn(secret_text, written)

                journal.unlink()
                journal.mkdir()
                status, _, set_cookie = request(port, "POST", "/api/login", {"password": PASSWORD}, origin=EXTERNAL)
                self.assertEqual(status, 202)
                status, payload, set_cookie = request(
                    port,
                    "POST",
                    "/api/login/totp",
                    {"code": code(secret, int(time.time()) + 30)},
                    session=f"shimpz_admin_ticket={ticket_cookie(set_cookie)}",
                    origin=EXTERNAL,
                )
                self.assertEqual((status, payload), (503, {"detail": "Supervisor authentication audit is unavailable"}))
                self.assertIsNone(session_cookie(set_cookie))
                self.assertNotIn("browser_origin", json.loads((root / "admin.json").read_text(encoding="utf-8")))
                self.assertEqual(request(port, "POST", "/api/login", {"password": "definitely wrong"})[0], 503)


def _line(ts: str, event: str, outcome: str = "ok", origin: str | None = EXTERNAL) -> str:
    return json.dumps({"ts": ts, "event": event, "outcome": outcome, "origin": origin}) + "\n"


def _moment(ts: str) -> int:
    return calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))


class SignInHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        isolated_store(self, state)
        self.journal = audit.path()
        self.journal.parent.mkdir(parents=True, exist_ok=True)

    def _write(self, path: Path, *lines: str) -> None:
        path.write_text("".join(lines), encoding="utf-8")
        path.chmod(0o600)

    def test_the_previous_sign_in_and_the_refused_attempts_since_it(self) -> None:
        self._write(
            self.journal,
            _line("2026-10-01T08:00:00Z", "setup-completed"),
            _line("2026-10-02T09:00:00Z", "login", origin="http://127.0.0.1:7777"),
            _line("2026-10-03T10:00:00Z", "password-rejected", "denied", None),
            _line("2026-10-03T10:01:00Z", "totp-rejected", "denied"),
            _line("2026-10-03T10:02:00Z", "recovery-code-locked", "denied"),
            _line("2026-10-03T10:03:00Z", "operation-confirmed"),
            _line("2026-10-03T10:04:00Z", "logout"),
            _line("2026-10-04T11:00:00Z", "login"),
            # A later sign-in, from another browser, is not the reader's own.
            _line("2026-10-05T12:00:00Z", "login"),
        )

        history = audit.sign_in_history(_moment("2026-10-04T11:00:00Z"))

        self.assertEqual(
            history,
            {"previous": {"at": "2026-10-02T09:00:00Z", "origin": "http://127.0.0.1:7777"}, "failures_since": 3},
        )
        self.assertEqual(audit.sign_in_history(_moment("2026-10-05T12:00:00Z"))["failures_since"], 0)

    def test_the_history_reads_the_rotated_backups_and_ignores_a_line_cut_short(self) -> None:
        self._write(self.journal.with_name("audit.jsonl.2"), _line("2026-10-01T08:00:00Z", "setup-completed"))
        self._write(self.journal.with_name("audit.jsonl.1"), _line("2026-10-02T08:00:00Z", "totp-locked", "denied"))
        self._write(self.journal, _line("2026-10-03T08:00:00Z", "recovery-completed"), '{"ts": "2026-10-03T')

        history = audit.sign_in_history(_moment("2026-10-03T08:00:00Z"))

        self.assertEqual(history, {"previous": {"at": "2026-10-01T08:00:00Z", "origin": EXTERNAL}, "failures_since": 1})

    def test_without_an_earlier_sign_in_there_is_no_previous_one(self) -> None:
        self.assertEqual(
            audit.sign_in_history(_moment("2026-10-03T08:00:00Z")), {"previous": None, "failures_since": 0}
        )
        self._write(self.journal, _line("2026-10-03T08:00:00Z", "login"))
        self.assertEqual(
            audit.sign_in_history(_moment("2026-10-03T08:00:00Z")), {"previous": None, "failures_since": 0}
        )

    def test_a_journal_that_is_not_exactly_what_admin_wrote_is_unavailable(self) -> None:
        for content in (
            "not json\n",
            "[]\n",
            _line("yesterday", "login"),
            _line("2026-10-03T08:00:00Z", "password-accepted"),
            _line("2026-10-03T08:00:00Z", "login", origin="HTTPS://ADMIN.EXAMPLE.TEST"),
            _line("2026-10-03T08:00:00Z", "login").replace(EXTERNAL, "\u00e9"),
        ):
            with self.subTest(content=content[:40]):
                self._write(self.journal, content)
                with self.assertRaises(audit.HistoryUnavailableError):
                    audit.sign_in_history(_moment("2026-10-03T08:00:00Z"))
        self._write(self.journal, _line("2026-10-03T08:00:00Z", "login"))
        self.journal.chmod(0o644)
        with self.assertRaises(audit.HistoryUnavailableError):
            audit.sign_in_history(_moment("2026-10-03T08:00:00Z"))


if __name__ == "__main__":
    unittest.main()
