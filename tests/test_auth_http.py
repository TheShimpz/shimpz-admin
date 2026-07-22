"""HTTP lifecycle contract for the local Admin authentication boundary."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
GOOD_PASSWORD = " ".join(("correct", "horse", "battery", "staple"))

from admin_http import AdminHTTPServer, request, session_cookie

sys.path.insert(0, str(BACKEND))
import auth


class AuthHTTPTests(unittest.TestCase):
    def test_real_http_lifecycle_persists_only_hardened_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "admin.json"
            with AdminHTTPServer(root, SHIMPZ_TEAM_CREDENTIALS_ENABLED="0") as server:
                self._exercise_lifecycle(server.port, store)

    def _exercise_lifecycle(self, port: int, store: Path) -> None:
        status, payload, _ = request(port, "GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(
            payload,
            {"authenticated": False, "initialized": False, "features": {"teamCredentials": False}},
        )
        self.assertEqual(request(port, "GET", "/api/state")[0], 401)
        self.assertEqual(request(port, "POST", "/api/admin/setup", {"password": "short"})[0], 400)

        status, payload, set_cookie = request(
            port,
            "POST",
            "/api/admin/setup",
            {"password": GOOD_PASSWORD},
        )
        session = session_cookie(set_cookie)
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertIsNotNone(session)
        self.assertEqual(request(port, "GET", "/api/state", session=session)[0], 200)

        self.assertEqual(store.stat().st_mode & 0o777, 0o600)
        disk = store.read_text(encoding="utf-8")
        self.assertNotIn(GOOD_PASSWORD, disk)
        record = json.loads(disk)
        self.assertTrue(record["password_hash"])
        self.assertTrue(record["salt"])
        self.assertTrue(record["session_secret"])

        self.assertEqual(
            request(port, "POST", "/api/admin/setup", {"password": "another good password"})[0],
            409,
        )
        logout_status, _, logout_cookie = request(port, "POST", "/api/logout")
        self.assertEqual(logout_status, 200)
        self.assertRegex(logout_cookie, r"shimpz_admin=.*(?:Max-Age=0|01 Jan 1970)")

        self.assertEqual(request(port, "POST", "/api/login", {"password": "definitely wrong"})[0], 401)
        login_status, login_payload, login_cookie = request(
            port,
            "POST",
            "/api/login",
            {"password": GOOD_PASSWORD},
        )
        fresh_session = session_cookie(login_cookie)
        self.assertEqual((login_status, login_payload), (200, {"ok": True}))
        self.assertIsNotNone(fresh_session)
        self.assertEqual(request(port, "GET", "/api/state", session=fresh_session)[0], 200)

        self.assertEqual(request(port, "GET", "/api/state", session="garbage-not-a-token")[0], 401)
        expired = auth.issue_session(record["session_secret"], ttl=-10)
        self.assertEqual(request(port, "GET", "/api/state", session=expired)[0], 401)
        foreign = auth.issue_session(auth.new_secret())
        self.assertEqual(request(port, "GET", "/api/state", session=foreign)[0], 401)
        self.assertEqual(request(port, "GET", "/")[0], 200)


if __name__ == "__main__":
    unittest.main()
