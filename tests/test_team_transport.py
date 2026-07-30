from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from team import transport


class _Response:
    status = 200

    @staticmethod
    def getheader(name: str) -> str | None:
        return {"Content-Type": "application/json", "Content-Length": "2"}.get(name)

    @staticmethod
    def read(_limit: int) -> bytes:
        return b"{}"


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


if __name__ == "__main__":
    unittest.main()
