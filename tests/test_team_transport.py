import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import supervisor
from team import transport


class _Response:
    status = 200

    @staticmethod
    def getheader(name: str) -> str | None:
        return {"Content-Type": "application/json", "Content-Length": "2"}.get(name)

    @staticmethod
    def read(_limit: int) -> bytes:
        return b"{}"


class _Refusal:
    """Team's answer to a bearer it did not issue on its current start."""

    status = 401

    def __init__(self, body: bytes = b'{"error":"authentication required","trace_id":"0123456789abcdef"}') -> None:
        self.body = body

    def getheader(self, name: str) -> str | None:
        return {"Content-Type": "application/json", "Content-Length": str(len(self.body))}.get(name)

    def read(self, _limit: int) -> bytes:
        body, self.body = self.body, b""
        return body


class _Stream:
    status = 200

    def __init__(self) -> None:
        self.lines = [b'{"type":"terminal","status":200,"body":{"ok":true}}\n']

    @staticmethod
    def getheader(name: str) -> str | None:
        return {"Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked"}.get(name)

    def readline(self, _limit: int) -> bytes:
        return self.lines.pop(0) if self.lines else b""

    @staticmethod
    def read(_limit: int) -> bytes:
        return b""


class TeamClientCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        with transport._token_cache_lock:
            transport._token_cache = None

    def test_calls_cache_token_by_file_identity_and_keep_connections_request_scoped(self) -> None:
        connections: list[mock.Mock] = []

        def connection_factory(*_args, **_kwargs):
            connection = mock.Mock()
            connection.getresponse.return_value = _Response()
            connections.append(connection)
            return connection

        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("first-controller-token", encoding="utf-8")
            with (
                mock.patch.object(transport, "TOKEN_FILE", str(token_file)),
                mock.patch.object(
                    transport,
                    "_read_token_file",
                    wraps=transport._read_token_file,
                ) as read_token,
                mock.patch.object(
                    transport.http.client,
                    "HTTPConnection",
                    side_effect=connection_factory,
                ) as open_connection,
            ):
                self.assertEqual(transport._call("GET", "/v1/teams").status, 200)
                self.assertEqual(transport._call("GET", "/v1/teams").status, 200)
                self.assertEqual(read_token.call_count, 1)

                token_file.write_text("rotated-controller-token-value", encoding="utf-8")
                self.assertEqual(transport._call("GET", "/v1/teams").status, 200)

        self.assertEqual(read_token.call_count, 2)
        self.assertEqual(open_connection.call_count, 3)
        self.assertEqual(len(connections), 3)
        for connection in connections:
            connection.close.assert_called_once_with()


class TeamBearerRotationTests(unittest.TestCase):
    """Team writes a fresh bearer on every start; Admin re-reads it once when Team refuses the cached one."""

    def setUp(self) -> None:
        with transport._token_cache_lock:
            transport._token_cache = None
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.token_file = Path(directory.name) / "token"
        self.token_file.write_text("first-token", encoding="utf-8")
        patcher = mock.patch.object(transport, "TOKEN_FILE", str(self.token_file))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sent: list[tuple[str, str, bytes | None, dict[str, str]]] = []

    def _team(self, *answers):
        """Answer each new connection with the next response, recording what each request sent."""
        pending = list(answers)

        def connection_factory(*_args, **_kwargs):
            connection = mock.Mock()

            def request(method, path, body=None, headers=None):
                self.sent.append((method, path, body, dict(headers)))

            connection.request.side_effect = request
            connection.getresponse.side_effect = lambda: pending.pop(0)
            return connection

        return mock.patch.object(transport.http.client, "HTTPConnection", side_effect=connection_factory)

    def _restart_team(self, refusal: _Refusal) -> _Refusal:
        """Team restarted after Admin cached its bearer: the file now holds a new one and the cached one is refused."""
        transport._team_token()
        # The same size and a restored mtime keep the file's identity, so only the refusal can make Admin re-read it.
        before = self.token_file.stat()
        self.token_file.write_text("fresh-token", encoding="utf-8")
        os.utime(self.token_file, ns=(before.st_atime_ns, before.st_mtime_ns))
        return refusal

    def test_a_refused_bearer_is_re_read_and_the_same_request_is_sent_once_more(self) -> None:
        refusal = self._restart_team(_Refusal())
        with self._team(refusal, _Response()), self.assertLogs("shimpz-admin", level="INFO") as logs:
            response = transport._call("PUT", "/v1/teams/team/inference", {"model": "m"})
        self.assertEqual(response, transport.TeamResponse(200, {}))
        self.assertEqual([item[3]["Authorization"] for item in self.sent], ["Bearer first-token", "Bearer fresh-token"])
        self.assertEqual(
            {(method, path, body) for method, path, body, _headers in self.sent},
            {("PUT", "/v1/teams/team/inference", b'{"model":"m"}')},
        )
        self.assertFalse(any("token" in line for line in logs.output))

    def test_a_second_refusal_answers_unavailable_without_a_third_request(self) -> None:
        refusal = self._restart_team(_Refusal())
        with self._team(refusal, _Refusal()), self.assertLogs("shimpz-admin", level="WARNING") as logs:
            response = transport._call("DELETE", "/v1/teams/team")
        self.assertEqual(response, transport.TeamResponse(502, {"detail": "team unavailable"}))
        self.assertEqual(len(self.sent), 2)
        self.assertFalse(any("token" in line for line in logs.output))

    def test_any_other_unauthorized_answer_is_invalid_and_never_resent(self) -> None:
        with self._team(_Refusal(b'{"error":"other"}')), self.assertLogs("shimpz-admin", level="WARNING"):
            response = transport._call("GET", "/v1/teams")
        self.assertEqual(response.status, 502)
        self.assertEqual(len(self.sent), 1)

    def test_a_streamed_request_is_resent_with_the_fresh_bearer(self) -> None:
        refusal = self._restart_team(_Refusal())
        with self._team(refusal, _Stream()):
            response = transport._call_stream(
                "POST",
                "/v1/teams/team/chat",
                {"message": "hello"},
                timeout=5,
                bindings=transport._NO_BINDINGS,
                progress=lambda _event: None,
            )
        self.assertEqual(response, transport.TeamResponse(200, {"ok": True}))
        self.assertEqual([item[3]["Authorization"] for item in self.sent], ["Bearer first-token", "Bearer fresh-token"])
        self.assertEqual(self.sent[0][2], self.sent[1][2])

    def test_a_supervisor_assertion_is_signed_afresh_for_the_resent_request(self) -> None:
        refusal = self._restart_team(_Refusal())
        identity = supervisor.new_identity()
        with (
            self._team(refusal, _Response()),
            transport.supervisor_session("session", local_identity=identity),
        ):
            transport._call("GET", "/v1/teams")
        assertions = [item[3][transport.supervisor_contract.ASSERTION_HEADER] for item in self.sent]
        self.assertEqual(len(set(assertions)), 2)


if __name__ == "__main__":
    unittest.main()
