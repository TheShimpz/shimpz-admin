"""The durable Supervisor authentication journal: metadata only, bounded, and fail-closed."""

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

import audit

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


if __name__ == "__main__":
    unittest.main()
