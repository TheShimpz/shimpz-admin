"""Fail-closed edge coverage for the Admin-to-Team HTTP transport."""

from __future__ import annotations

import sys
import tempfile
import unittest
from http import HTTPStatus
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import supervisor
from protocol.http.v1 import progress as progress_contract
from team import transport


class _Response:
    def __init__(
        self,
        status: int = 200,
        *,
        headers: dict[str, str] | None = None,
        body: bytes = b"{}",
        lines: list[bytes] | None = None,
    ) -> None:
        self.status = status
        self.headers = headers or {
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        self.body = body
        self.lines = list(lines or [])

    def getheader(self, name: str) -> str | None:
        return self.headers.get(name)

    def read(self, limit: int) -> bytes:
        body, self.body = self.body[:limit], self.body[limit:]
        return body

    def readline(self, _limit: int) -> bytes:
        return self.lines.pop(0) if self.lines else b""


class _Connection:
    response = _Response()
    close_error = False

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def request(self, *_args, **_kwargs) -> None:
        pass

    def getresponse(self) -> _Response:
        return self.response

    def close(self) -> None:
        if self.close_error:
            raise OSError("close failed")


class TeamTransportEdgeTests(unittest.TestCase):
    def setUp(self) -> None:
        with transport._token_cache_lock:
            transport._token_cache = None

    def test_supervisor_context_rejects_mixed_or_missing_local_authority(self) -> None:
        identity = supervisor.new_identity()
        with (
            self.assertRaisesRegex(transport.TeamRequestError, "cannot carry"),
            transport.supervisor_session("session", account=True, local_identity=identity),
        ):
            pass

        reset = transport._SUPERVISOR_SESSION.set(transport._SupervisorSession("session", False, None))
        try:
            with self.assertRaises(supervisor.SupervisorAuthorityError):
                transport._local_assertion(
                    "GET",
                    "/v1/teams",
                    None,
                    content_type=None,
                    filename=None,
                    bindings=transport._RequestBindings(),
                )
        finally:
            transport._SUPERVISOR_SESSION.reset(reset)

        with transport.supervisor_session("session", account=False, local_identity=identity):
            with self.assertRaisesRegex(supervisor.SupervisorAuthorityError, "file binding"):
                transport._local_assertion(
                    "POST",
                    "/v1/file",
                    None,
                    content_type=None,
                    filename="file.txt",
                    bindings=transport._RequestBindings(),
                )
            self.assertTrue(
                transport._local_assertion(
                    "GET",
                    "/v1/teams",
                    None,
                    content_type=None,
                    filename=None,
                    bindings=transport._RequestBindings(),
                )
            )

    def test_token_payload_and_endpoint_contracts_reject_invalid_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("   ", encoding="utf-8")
            with mock.patch.object(transport, "TOKEN_FILE", str(token_file)), self.assertRaisesRegex(OSError, "empty"):
                transport._team_token()

            token_file.write_text("valid-token", encoding="utf-8")
            identity = transport._token_identity(token_file)
            with (
                mock.patch.object(transport, "TOKEN_FILE", str(token_file)),
                mock.patch.object(transport, "_token_identity", side_effect=[identity, (0, 0, 0, 0)]),
                self.assertRaisesRegex(OSError, "changed"),
            ):
                transport._team_token()

        invalid_payloads = ([], {"bad": object()})
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(transport.TeamRequestError):
                transport._encode_payload(payload)
        with self.assertRaisesRegex(transport.TeamRequestError, "exceeds"):
            transport._encode_payload({"large": "xx"}, max_bytes=1)

        for url in ("http://[", "https://team", "http://team:bad"):
            with mock.patch.object(transport, "URL", url), self.assertRaisesRegex(OSError, "invalid team endpoint"):
                transport._endpoint()

    def test_json_response_decoder_rejects_ambiguous_or_unbounded_bodies(self) -> None:
        cases = (
            _Response(204, headers={"Content-Length": "1"}, body=b"x"),
            _Response(headers={"Content-Type": "application/json", "Content-Length": "bad"}),
            _Response(
                headers={"Content-Type": "application/json"},
                body=b"x" * (transport.MAX_JSON_RESPONSE_BYTES + 1),
            ),
            _Response(body=b"{"),
        )
        for response in cases:
            with self.subTest(headers=response.headers), self.assertRaisesRegex(OSError, "invalid team response"):
                transport._decode_response(response)

        empty = _Response(headers={"Content-Type": "application/json"}, body=b"")
        self.assertEqual(transport._decode_response(empty), {})

    def test_request_status_close_and_private_credential_fail_closed(self) -> None:
        with (
            mock.patch.object(transport, "_team_token", return_value="token"),
            self.assertRaisesRegex(OSError, "invalid private model credential"),
        ):
            transport._request_headers(
                "GET",
                "/v1/teams",
                None,
                accept="application/json",
                content_type=None,
                filename=None,
                bindings=transport._RequestBindings(("unknown", "secret-secret-secret")),
            )

        _Connection.response = _Response(99)
        _Connection.close_error = False

    def test_each_request_preflight_failure_is_a_closed_gateway_error(self) -> None:
        with mock.patch.object(transport, "_endpoint", side_effect=OSError("invalid")):
            self.assertEqual(
                transport._request(
                    "GET",
                    "/v1/teams",
                    None,
                    content_type=None,
                    filename=None,
                    timeout=1,
                ).status,
                HTTPStatus.BAD_GATEWAY,
            )
            self.assertEqual(transport._request_asset("GET", "/icon").status, HTTPStatus.BAD_GATEWAY)
            self.assertEqual(
                transport._stream_request(
                    "POST",
                    "/chat",
                    b"{}",
                    timeout=1,
                    bindings=transport._RequestBindings(),
                    progress=mock.Mock(),
                ).status,
                HTTPStatus.BAD_GATEWAY,
            )
        with (
            mock.patch.object(transport, "_endpoint", return_value=("team", 7077)),
            mock.patch.object(transport, "_team_token", return_value="token"),
            mock.patch.object(transport.http.client, "HTTPConnection", _Connection),
        ):
            self.assertEqual(transport._call("GET", "/v1/teams").status, 502)

        _Connection.response = _Response()
        _Connection.close_error = True
        with (
            mock.patch.object(transport, "_endpoint", return_value=("team", 7077)),
            mock.patch.object(transport, "_team_token", return_value="token"),
            mock.patch.object(transport.http.client, "HTTPConnection", _Connection),
        ):
            self.assertEqual(transport._call("GET", "/v1/teams").status, 200)
        _Connection.close_error = False

    def test_asset_decoder_rejects_invalid_status_metadata_and_lengths(self) -> None:
        error = transport._decode_asset(_Response(404, body=b'{"detail":"missing"}'))
        self.assertEqual(error.status, 404)
        self.assertIsNone(error.contents)

        cases = (
            _Response(headers={"Content-Type": "image/png", "Content-Length": "bad"}, body=b"x"),
            _Response(headers={"Content-Type": "image/png", "Content-Length": "0"}, body=b""),
            _Response(headers={"Content-Type": "image/png", "Content-Length": "2"}, body=b"x"),
        )
        for response in cases:
            with self.subTest(headers=response.headers), self.assertRaisesRegex(OSError, "invalid Team asset response"):
                transport._decode_asset(response)

        _Connection.response = _Response(99)
        with (
            mock.patch.object(transport, "_endpoint", return_value=("team", 7077)),
            mock.patch.object(transport, "_team_token", return_value="token"),
            mock.patch.object(transport.http.client, "HTTPConnection", _Connection),
        ):
            self.assertEqual(transport._request_asset("GET", "/icon").status, HTTPStatus.BAD_GATEWAY)

    def test_stream_decoder_rejects_headers_size_and_terminal_residue(self) -> None:
        with self.assertRaisesRegex(OSError, "invalid Team chat stream"):
            transport._decode_stream(_Response(), mock.Mock())

        oversized = progress_contract.encode_record(
            {"type": "progress", "seq": 1, "phase": "model", "state": "started"}
        )
        response = _Response(
            headers={"Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked"},
            lines=[oversized],
        )
        with (
            mock.patch.object(progress_contract, "MAX_STREAM_BYTES", len(oversized) - 1),
            self.assertRaisesRegex(OSError, "exceeded its limit"),
        ):
            transport._decode_stream(response, mock.Mock())

        terminal = progress_contract.encode_record({"type": "terminal", "status": 200, "body": {}})
        response = _Response(
            headers={"Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked"},
            body=b"residue",
            lines=[terminal],
        )
        with self.assertRaisesRegex(OSError, "continued after terminal"):
            transport._decode_stream(response, mock.Mock())

    def test_wrapper_rejects_absent_stream_and_invalid_raw_body(self) -> None:
        with self.assertRaisesRegex(transport.TeamRequestError, "body is required"):
            transport._call_stream(
                "POST",
                "/chat",
                None,
                timeout=1,
                bindings=transport._RequestBindings(),
                progress=mock.Mock(),
            )
        for body, filename, media_type in (("bad", "x", "text/plain"), (b"x", 7, "text/plain")):
            with self.subTest(body=body), self.assertRaisesRegex(transport.TeamRequestError, "raw file"):
                transport._call_raw("POST", "/file", body, filename=filename, media_type=media_type)


if __name__ == "__main__":
    unittest.main()
