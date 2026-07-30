"""Hosted Admin Account-session adapter security contracts."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from integrations import account

ACCOUNT_ID = "a" * 32
SESSION = "a1:" + ACCOUNT_ID + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)


class _Response:
    def __init__(self, status: int, body: dict[str, object]) -> None:
        self.status = status
        self._body = json.dumps(body, separators=(",", ":")).encode()

    def getheader(self, name: str) -> str | None:
        return {
            "Content-Type": "application/json",
            "Content-Length": str(len(self._body)),
        }.get(name)

    def read(self, limit: int) -> bytes:
        return self._body[:limit]


class _Connection:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.requests: list[tuple[str, str, bytes, dict[str, str]]] = []
        self.closed = False

    def request(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> None:
        self.requests.append((method, path, body, headers))

    def getresponse(self) -> _Response:
        return self.response

    def close(self) -> None:
        self.closed = True


class AccountSessionAdapterTests(unittest.TestCase):
    def test_capability_is_exact_regular_mode_0440_and_never_cached(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token_file = root / "token"
            token_file.write_text("d" * 64)
            token_file.chmod(0o440)
            with mock.patch.object(account, "SESSION_TOKEN_FILE", token_file):
                self.assertEqual(account._session_capability(), "d" * 64)
                token_file.chmod(0o400)
                self.assertEqual(account._session_capability(), "")
                token_file.chmod(0o600)
                token_file.write_text("e" * 64)
                token_file.chmod(0o440)
                self.assertEqual(account._session_capability(), "e" * 64)

                token_file.unlink()
                target = root / "target"
                target.write_text("f" * 64)
                target.chmod(0o440)
                token_file.symlink_to(target)
                self.assertEqual(account._session_capability(), "")

    def test_introspection_sends_only_the_dedicated_capability_and_closed_request(self) -> None:
        response = _Response(
            200,
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
        )
        connection = _Connection(response)
        with (
            mock.patch.object(account, "_session_capability", return_value="d" * 64),
            mock.patch.object(account.http.client, "HTTPConnection", return_value=connection),
        ):
            result = account.introspect(SESSION)

        self.assertEqual(
            result,
            account.AccountResponse(
                200,
                {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": True},
            ),
        )
        self.assertTrue(connection.closed)
        method, path, body, headers = connection.requests[0]
        self.assertEqual((method, path), ("POST", "/v1/internal/admin/sessions/introspect"))
        self.assertEqual(json.loads(body), {"version": 1, "token": SESSION})
        self.assertEqual(headers["Authorization"], "Bearer " + ("d" * 64))
        self.assertNotIn("X-Forwarded-For", headers)

    def test_invalid_or_overdisclosing_introspection_response_fails_closed(self) -> None:
        responses = (
            {"version": 1, "active": False, "account_id": ACCOUNT_ID},
            {"version": 1, "active": True, "account_id": ACCOUNT_ID, "supervisor": 1},
            {"version": True, "active": False},
        )
        for body in responses:
            with (
                self.subTest(body=body),
                mock.patch.object(
                    account,
                    "_call",
                    return_value=account.AccountResponse(200, body),
                ),
            ):
                result = account.introspect(SESSION)
                self.assertEqual(result.status, 502)
                self.assertNotIn(SESSION, json.dumps(result.body))

    def test_login_and_sudo_forward_client_ip_without_logging_credentials(self) -> None:
        login_body = {"account_id": ACCOUNT_ID, "username": "supervisor-user", "token": SESSION}
        with mock.patch.object(account, "_call", return_value=account.AccountResponse(200, login_body)) as call:
            result = account.login("supervisor-user", "private-password", "192.0.2.1")

        self.assertEqual(result.status, 200)
        call.assert_called_once_with(
            "/v1/login",
            {"username": "supervisor-user", "password": "private-password"},
            client_ip="192.0.2.1",
        )

        sudo_body = {"verified": True, "amr": ["pwd"], "strong_auth_at": 1}
        with mock.patch.object(account, "_call", return_value=account.AccountResponse(200, sudo_body)) as call:
            result = account.verify_sudo_password(SESSION, "private-password", "192.0.2.1")

        self.assertEqual(result.status, 200)
        call.assert_called_once_with(
            "/v1/security/sudo/password",
            {"token": SESSION, "password": "private-password"},
            client_ip="192.0.2.1",
        )


if __name__ == "__main__":
    unittest.main()
