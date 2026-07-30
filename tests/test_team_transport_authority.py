"""Request-scoped human authority contracts for the Admin-to-Team transport."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import transport


class _Response:
    status = 200
    body = b"{}"

    def __init__(self) -> None:
        self._body = self.__class__.body

    def getheader(self, name: str) -> str | None:
        return {
            "Content-Length": str(len(self._body)),
            "Content-Type": "application/json",
        }.get(name)

    def read(self, _limit: int) -> bytes:
        body, self._body = self._body, b""
        return body


class _Connection:
    requests: ClassVar[list[dict[str, object]]] = []

    def __init__(self, _host: str, _port: int, *, timeout: int) -> None:
        self.timeout = timeout

    def request(self, method: str, path: str, *, body: bytes | None, headers: dict[str, str]) -> None:
        self.__class__.requests.append(
            {
                "method": method,
                "path": path,
                "body": body,
                "headers": dict(headers),
            }
        )

    def getresponse(self) -> _Response:
        return _Response()

    def close(self) -> None:
        return None


class TeamTransportAuthorityTest(unittest.TestCase):
    def setUp(self) -> None:
        _Connection.requests = []
        _Response.status = 200
        _Response.body = b"{}"
        self.patches = (
            mock.patch.object(transport, "_endpoint", return_value=("team", 7077)),
            mock.patch.object(transport, "_team_token", return_value="machine-bearer"),
            mock.patch.object(transport.http.client, "HTTPConnection", _Connection),
        )
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_account_session_is_request_scoped_and_never_sent_by_local(self) -> None:
        account_session = "a1:" + ("a" * 32) + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)
        with transport.supervisor_session(account_session, account=True):
            transport._call("GET", "/v1/teams")
        transport._call("GET", "/v1/teams")
        with transport.supervisor_session(account_session, account=False):
            transport._call("GET", "/v1/teams")

        self.assertEqual(_Connection.requests[0]["headers"]["X-Shimpz-Account"], account_session)
        self.assertNotIn("X-Shimpz-Account", _Connection.requests[1]["headers"])
        self.assertNotIn("X-Shimpz-Account", _Connection.requests[2]["headers"])
        self.assertEqual(transport._account_session(), "")

    def test_invalid_session_and_authority_kind_fail_before_transport(self) -> None:
        account_session = "a1:" + ("a" * 32) + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)
        for invalid in ("", "x\ninjected", None, "a" * 2049):
            with (
                self.subTest(invalid=invalid),
                self.assertRaises(transport.TeamRequestError),
                transport.supervisor_session(invalid, account=True),
            ):
                pass
        with (
            self.assertRaises(transport.TeamRequestError),
            transport.supervisor_session(account_session, account=None),
        ):
            pass
        self.assertEqual(_Connection.requests, [])

    def test_empty_no_content_response_is_preserved(self) -> None:
        _Response.status = 204
        _Response.body = b""

        response = transport._call(
            "DELETE",
            "/v1/teams/team_1/assistant-integrations/social-publisher/x-integration",
        )

        self.assertEqual(response, transport.TeamResponse(204, {}))


if __name__ == "__main__":
    unittest.main()
