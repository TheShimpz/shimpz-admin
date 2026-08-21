"""HTTP lifecycle contract for the local Admin authentication boundary."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
GOOD_PASSWORD = "violet otter lantern quartz 92"

from admin_http import AdminHTTPServer, request, request_with_headers, session_cookie

sys.path.insert(0, str(BACKEND))
import auth


class AuthHTTPTests(unittest.TestCase):
    def test_real_http_lifecycle_persists_only_hardened_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "admin.json"
            with AdminHTTPServer(root, SHIMPZ_TEAM_CREDENTIALS_ENABLED="0") as server:
                self._exercise_lifecycle(server.port, store)

    def test_real_http_login_locks_after_five_rejected_passwords(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with AdminHTTPServer(root) as server:
                self.assertEqual(
                    request(server.port, "POST", "/api/admin/setup", {"password": GOOD_PASSWORD})[0],
                    200,
                )
                for _ in range(4):
                    self.assertEqual(
                        request(server.port, "POST", "/api/login", {"password": "definitely wrong"})[0],
                        401,
                    )
                status, payload, headers = request_with_headers(
                    server.port,
                    "POST",
                    "/api/login",
                    {"password": "definitely wrong"},
                )

                self.assertEqual(status, 429)
                self.assertEqual(payload, {"detail": "too many login attempts"})
                self.assertEqual(headers["retry-after"], "60")

    def test_retired_password_record_is_health_visible_but_grants_no_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "admin.json"
            store.write_text(
                json.dumps(
                    {
                        "salt": "00" * 32,
                        "password_hash": "11" * 32,
                        "session_secret": "22" * 32,
                    }
                ),
                encoding="utf-8",
            )
            with AdminHTTPServer(root) as server:
                self.assertEqual(
                    request(server.port, "POST", "/api/session")[:2],
                    (
                        200,
                        {
                            "profile": "local",
                            "authenticated": False,
                            "initialized": True,
                            "password_state": "recovery-required",
                            "features": {"teamCredentials": True},
                        },
                    ),
                )
                for method, path, body in (
                    ("POST", "/api/login", {"password": GOOD_PASSWORD}),
                    ("POST", "/api/admin/setup", {"password": GOOD_PASSWORD}),
                    ("DELETE", "/api/space/bootstrap", {}),
                    ("GET", "/api/model-providers", None),
                ):
                    with self.subTest(path=path):
                        status, payload, _ = request(server.port, method, path, body)
                        self.assertEqual(status, 503)
                        self.assertEqual(payload["code"], "password-recovery-required")

    def _exercise_lifecycle(self, port: int, store: Path) -> None:
        status, payload, _ = request(port, "POST", "/api/session", origin=f"http://127.0.0.1:{port}")
        self.assertEqual(status, 200)
        self.assertEqual(
            payload,
            {
                "profile": "local",
                "authenticated": False,
                "initialized": False,
                "password_state": "uninitialized",
                "features": {"teamCredentials": False},
            },
        )
        self.assertEqual(request(port, "GET", "/api/model-providers")[0], 401)
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
        self.assertEqual(request(port, "GET", "/api/model-providers", session=session)[0], 200)

        self.assertEqual(store.stat().st_mode & 0o777, 0o600)
        disk = store.read_text(encoding="utf-8")
        self.assertNotIn(GOOD_PASSWORD, disk)
        record = json.loads(disk)
        self.assertTrue(record["password_verifier"].startswith("scrypt-v1$ln=14,r=8,p=5,dk=32$"))
        self.assertNotIn("password_hash", record)
        self.assertNotIn("salt", record)
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
        self.assertEqual(request(port, "GET", "/api/model-providers", session=fresh_session)[0], 200)

        status, payload, _ = request(
            port,
            "POST",
            "/api/session",
            session=fresh_session,
            origin=f"http://127.0.0.1:{port}",
        )
        self.assertEqual(status, 200)
        self.assertIs(payload["origin_admitted"], True)
        self.assertIsNone(payload["oauth_completion_mode"])

        self.assertEqual(request(port, "GET", "/api/model-providers", session="garbage-not-a-token")[0], 401)
        expired = auth.issue_session(record["session_secret"], ttl=-10)
        self.assertEqual(request(port, "GET", "/api/model-providers", session=expired)[0], 401)
        foreign = auth.issue_session(auth.new_secret())
        self.assertEqual(request(port, "GET", "/api/model-providers", session=foreign)[0], 401)
        self.assertEqual(request(port, "GET", "/")[0], 200)


if __name__ == "__main__":
    unittest.main()
