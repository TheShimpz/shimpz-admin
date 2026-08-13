"""Request-scoped human authority contracts for the Admin-to-Team transport."""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import supervisor
from team import transport

from protocol.http.v1 import supervisor as contract


def _claims(request: dict[str, object]) -> dict[str, object]:
    headers = request["headers"]
    assert isinstance(headers, dict)
    encoded = headers[contract.ASSERTION_HEADER].removeprefix("Bearer ")
    payload = encoded.split(".")[1]
    raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
    return contract.canonical_claims(json.loads(raw))


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
        self.local_identity = supervisor.new_identity()

    def test_account_session_is_request_scoped_and_never_sent_by_local(self) -> None:
        account_session = "a1:" + ("a" * 32) + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)
        with transport.supervisor_session(account_session, account=True):
            transport._call("GET", "/v1/teams")
        transport._call("GET", "/v1/teams")
        with transport.supervisor_session(
            account_session,
            account=False,
            local_identity=self.local_identity,
        ):
            transport._call("GET", "/v1/teams")

        self.assertEqual(_Connection.requests[0]["headers"]["X-Shimpz-Account"], account_session)
        self.assertNotIn("X-Shimpz-Account", _Connection.requests[1]["headers"])
        self.assertNotIn("X-Shimpz-Account", _Connection.requests[2]["headers"])
        self.assertIn(contract.ASSERTION_HEADER, _Connection.requests[2]["headers"])
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
        with (
            self.assertRaises(transport.TeamRequestError),
            transport.supervisor_session(account_session, account=False),
        ):
            pass
        self.assertEqual(_Connection.requests, [])

    def test_local_assertion_binds_json_model_and_session_without_disclosing_the_key(self) -> None:
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        api_key = "sk-test-0123456789"
        with transport.supervisor_session(
            session,
            account=False,
            local_identity=self.local_identity,
        ):
            transport._call(
                "POST",
                "/v1/teams/team_1/chat",
                {"message": "hello"},
                model_credential=("openai", api_key),
            )

        request = _Connection.requests[0]
        claims = _claims(request)
        raw = request["body"]
        self.assertIsInstance(raw, bytes)
        self.assertEqual(
            claims["body"],
            {
                "kind": "json",
                "length": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            },
        )
        self.assertEqual(
            claims["model"],
            {
                "provider": "openai",
                "key_sha256": hashlib.sha256(api_key.encode()).hexdigest(),
            },
        )
        self.assertEqual(claims["session_sha256"], hashlib.sha256(session.encode()).hexdigest())
        self.assertNotIn("assurance", claims)
        self.assertNotIn(api_key, json.dumps(claims))

    def test_local_assertion_binds_exact_human_assurance(self) -> None:
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        assurance = {
            "kind": "auth:password",
            "challenge_id": "d" * 32,
        }
        with transport.supervisor_session(
            session,
            account=False,
            local_identity=self.local_identity,
        ):
            encoded = transport._local_assertion(
                "POST",
                "/v1/teams/team_1/chat/human",
                b'{"challenge_id":"dddddddddddddddddddddddddddddddd","decision":"submit","value":true}',
                content_type="application/json",
                filename=None,
                bindings=transport._RequestBindings(
                    ("openai", "sk-test-0123456789"),
                    assurance,
                ),
            )

        payload = encoded.split(".")[1]
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        claims = contract.canonical_claims(json.loads(raw))
        self.assertEqual(claims["assurance"], assurance)

    def test_local_file_assertion_binds_metadata_without_embedding_content(self) -> None:
        content = b"private Team file"
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        with transport.supervisor_session(
            session,
            account=False,
            local_identity=self.local_identity,
        ):
            transport._call_raw(
                "POST",
                "/v1/teams/team_1/files",
                content,
                filename="brief.txt",
                media_type="text/plain",
            )

        claims = _claims(_Connection.requests[0])
        self.assertEqual(
            claims["body"],
            {
                "kind": "file",
                "length": len(content),
                "filename": "brief.txt",
                "media_type": "text/plain",
            },
        )
        self.assertNotIn(content.decode(), json.dumps(claims))

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
