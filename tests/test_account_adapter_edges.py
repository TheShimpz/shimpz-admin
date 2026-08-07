"""Closed failure and concurrency boundaries for the Hosted Account adapter."""

from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from integrations import account


class _Response:
    def __init__(
        self,
        status: int = 200,
        *,
        content_type: str = "application/json",
        content_length: str | None = None,
        body: bytes = b"{}",
    ) -> None:
        self.status = status
        self.content_type = content_type
        self.content_length = str(len(body)) if content_length is None else content_length
        self.body = body

    def getheader(self, name: str) -> str | None:
        return {"Content-Type": self.content_type, "Content-Length": self.content_length}.get(name)

    def read(self, limit: int) -> bytes:
        return self.body[:limit]


class _Connection:
    response = _Response()
    close_error = False
    last_headers: ClassVar[dict[str, str]] = {}

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def request(self, _method: str, _path: str, *, body: bytes, headers: dict[str, str]) -> None:
        type(self).last_headers = headers

    def getresponse(self) -> _Response:
        return self.response

    def close(self) -> None:
        if self.close_error:
            raise OSError("close failed")


class AccountAdapterEdgeTests(unittest.TestCase):
    def test_capability_read_failure_closes_its_open_descriptor(self) -> None:
        with (
            mock.patch.object(account.os, "open", return_value=7),
            mock.patch.object(account.os, "fstat", side_effect=OSError("unavailable")),
            mock.patch.object(account.os, "close") as close,
        ):
            self.assertEqual(account._session_capability(), "")
        close.assert_called_once_with(7)

    def test_bounded_executor_releases_permits_on_success_failure_and_saturation(self) -> None:
        executor = account._BoundedExecutor()
        self.addCleanup(executor.shutdown, wait=True)
        self.assertEqual(executor.submit(lambda: "done").result(), "done")

        permit = mock.Mock()
        permit.acquire.return_value = False
        executor._permits = permit
        with self.assertRaises(account.ExecutorSaturatedError):
            executor.submit(lambda: None)

        permit.acquire.return_value = True
        with (
            mock.patch.object(
                concurrent.futures.ThreadPoolExecutor,
                "submit",
                side_effect=RuntimeError("submit failed"),
            ),
            self.assertRaisesRegex(RuntimeError, "submit failed"),
        ):
            executor.submit(lambda: None)
        permit.release.assert_called_once_with()

    def test_endpoint_payload_and_response_decoders_fail_closed(self) -> None:
        for url in ("http://[", "https://account", "http://account/path"):
            with mock.patch.object(account, "URL", url), self.assertRaisesRegex(OSError, "invalid Account endpoint"):
                account._endpoint()

        for value in ({"bad": object()}, {"large": "xx"}):
            with (
                self.subTest(value=value),
                mock.patch.object(account, "MAX_REQUEST_BYTES", 1),
                self.assertRaisesRegex(OSError, "invalid Account request"),
            ):
                account._payload(value)

        cases = (
            _Response(content_type="text/plain"),
            _Response(content_length="bad"),
            _Response(body=b""),
            _Response(body=b"{"),
            _Response(body=b"[]"),
        )
        for response in cases:
            with self.subTest(response=response), self.assertRaisesRegex(OSError, "invalid Account response"):
                account._response_body(response)
        with (
            mock.patch.object(account, "MAX_RESPONSE_BYTES", 1),
            self.assertRaisesRegex(OSError, "invalid Account response"),
        ):
            account._response_body(_Response(content_length="2", body=b"{}"))

    def test_request_preflight_status_headers_and_close_fail_closed(self) -> None:
        with mock.patch.object(account, "_session_capability", return_value=""):
            self.assertEqual(account._call("/v1", {}, capability=True).status, 502)

        _Connection.response = _Response(200)
        _Connection.close_error = True
        with mock.patch.object(account.http.client, "HTTPConnection", _Connection):
            self.assertEqual(account._call("/v1", {}, client_ip="192.0.2.1").status, 200)
        self.assertEqual(_Connection.last_headers["X-Forwarded-For"], "192.0.2.1")

        _Connection.response = _Response(99)
        _Connection.close_error = False
        with mock.patch.object(account.http.client, "HTTPConnection", _Connection):
            self.assertEqual(account._call("/v1", {}).status, 502)

        with mock.patch.object(account.http.client, "HTTPConnection", side_effect=OSError("offline")):
            self.assertEqual(account._call("/v1", {}).status, 502)

    def test_public_operations_preserve_errors_and_reject_invalid_success(self) -> None:
        unavailable = account.AccountResponse(503, {"error": "offline"})
        with mock.patch.object(account, "_call", return_value=unavailable):
            self.assertEqual(account.login("user", "password", "192.0.2.1"), unavailable)
            self.assertEqual(account.introspect("token"), unavailable)

        invalid_login = account.AccountResponse(200, {"account_id": "bad", "username": "bad", "token": ""})
        with mock.patch.object(account, "_call", return_value=invalid_login):
            self.assertEqual(account.login("user", "password", "192.0.2.1").status, 502)

        with mock.patch.object(account, "_call", return_value=account.AccountResponse(200, {"logged_out": False})):
            self.assertEqual(account.logout("token").status, 502)
        with mock.patch.object(account, "_call", return_value=account.AccountResponse(200, {"logged_out": True})):
            self.assertEqual(account.logout("token").status, 200)

        invalid_sudo = account.AccountResponse(200, {"verified": False, "amr": [], "strong_auth_at": True})
        with mock.patch.object(account, "_call", return_value=invalid_sudo):
            self.assertEqual(account.verify_sudo_password("token", "password", "192.0.2.1").status, 502)
        with mock.patch.object(account, "_call", return_value=unavailable):
            self.assertEqual(account.verify_sudo_password("token", "password", "192.0.2.1"), unavailable)

    def test_async_adapter_returns_result_and_maps_saturation(self) -> None:
        expected = account.AccountResponse(200, {"active": True})
        self.assertEqual(asyncio.run(account.run_bounded(lambda: expected)), expected)

        async def saturated() -> None:
            loop = asyncio.get_running_loop()
            with mock.patch.object(loop, "run_in_executor", side_effect=account.ExecutorSaturatedError):
                result = await account.run_bounded(mock.Mock())
            self.assertEqual(result, account.AccountResponse(503, {"error": "Account identity is busy"}))

        asyncio.run(saturated())


if __name__ == "__main__":
    unittest.main()
