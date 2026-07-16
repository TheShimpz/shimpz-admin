"""Focused contracts for the stateless per-Capsule Driver credential proxy."""

from __future__ import annotations

import ast
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import driver_proxy


class _LocalDriverHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []
    response_status = 200
    response_body = b'{"ok":true}'
    response_headers: ClassVar[dict[str, str]] = {"Content-Type": "application/json"}

    def log_message(self, *_args):
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        self.__class__.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "body": body,
                "headers": {key.lower(): value for key, value in self.headers.items()},
            }
        )
        self.send_response(self.__class__.response_status)
        headers = dict(self.__class__.response_headers)
        headers.setdefault("Content-Length", str(len(self.__class__.response_body)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.__class__.response_body:
            self.wfile.write(self.__class__.response_body)

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle


class DriverProxyTest(unittest.TestCase):
    def setUp(self):
        _LocalDriverHandler.requests = []
        _LocalDriverHandler.response_status = 200
        _LocalDriverHandler.response_body = b'{"ok":true}'
        _LocalDriverHandler.response_headers = {"Content-Type": "application/json"}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _LocalDriverHandler)
        self.server_thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.server_thread.start()
        self.addCleanup(self._stop_server)

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.token_file = Path(self.tempdir.name) / "token"
        self.token_file.write_text("test-bearer\n", encoding="utf-8")
        self.patches = (
            mock.patch.object(driver_proxy, "TOKEN_FILE", str(self.token_file)),
            mock.patch.object(driver_proxy, "URL", f"http://127.0.0.1:{self.server.server_port}"),
        )
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def _stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)

    def test_forwards_only_json_with_existing_bearer_and_timeout(self):
        payload = {"label": "primary", "values": {"secret_access_key": "do-not-log"}}
        result = driver_proxy.create_credential("capsule_1", "cloudflare-r2", payload)

        self.assertEqual(result, driver_proxy.ProxyResponse(200, {"ok": True}))
        request = _LocalDriverHandler.requests[-1]
        self.assertEqual(driver_proxy.TIMEOUT_SECONDS, 30)
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/v1/capsules/capsule_1/drivers/cloudflare-r2/credentials")
        self.assertEqual(json.loads(request["body"]), payload)
        self.assertEqual(request["headers"]["content-type"], "application/json")
        self.assertEqual(request["headers"]["accept"], "application/json")
        self.assertEqual(request["headers"]["authorization"], "Bearer test-bearer")

    def test_get_sends_no_body_or_content_type(self):
        driver_proxy.get_driver("capsule_1", "cloudflare-r2")

        for request in _LocalDriverHandler.requests:
            self.assertEqual(request["body"], b"")
            self.assertNotIn("content-type", request["headers"])

    def test_delete_can_forward_json_generation_guard(self):
        payload = {"expected_generation": 7}
        driver_proxy.delete_credential("capsule_1", "cloudflare-r2", "9a-primary", payload)

        request = _LocalDriverHandler.requests[-1]
        self.assertEqual(request["method"], "DELETE")
        self.assertEqual(json.loads(request["body"]), payload)
        self.assertEqual(request["headers"]["content-type"], "application/json")

    def test_all_operations_use_fixed_canonical_paths(self):
        driver_proxy.replace_credential("capsule_1", "cloudflare-r2", "primary-1", {"values": {}})
        driver_proxy.verify_credential("capsule_1", "cloudflare-r2", "primary-1", {})

        requests = [(request["method"], request["path"]) for request in _LocalDriverHandler.requests]
        self.assertEqual(
            requests,
            [
                (
                    "PUT",
                    "/v1/capsules/capsule_1/drivers/cloudflare-r2/credentials/primary-1",
                ),
                (
                    "POST",
                    "/v1/capsules/capsule_1/drivers/cloudflare-r2/credentials/primary-1/verify",
                ),
            ],
        )

    def test_rejects_noncanonical_resource_ids_before_network_access(self):
        invalid = (
            lambda: driver_proxy.get_driver("Capsule_1", "cloudflare-r2"),
            lambda: driver_proxy.get_driver("capsule/1", "cloudflare-r2"),
            lambda: driver_proxy.get_driver("capsule_1", "Cloudflare-R2"),
            lambda: driver_proxy.get_driver("capsule_1", "cloudflare--r2"),
            lambda: driver_proxy.delete_credential("capsule_1", "cloudflare-r2", "../primary", {}),
            lambda: driver_proxy.delete_credential("capsule_1", "cloudflare-r2", "primary_1", {}),
        )
        for operation in invalid:
            with self.subTest(operation=operation), self.assertRaises(driver_proxy.ProxyRequestError):
                operation()
        self.assertEqual(_LocalDriverHandler.requests, [])

    def test_rejects_non_object_non_finite_and_oversized_payloads(self):
        invalid = [[], {"number": float("nan")}, {"secret": "x" * driver_proxy.MAX_JSON_BODY_BYTES}]
        for payload in invalid:
            with self.subTest(payload_type=type(payload).__name__), self.assertRaises(driver_proxy.ProxyRequestError):
                driver_proxy.create_credential("capsule_1", "cloudflare-r2", payload)
        self.assertEqual(_LocalDriverHandler.requests, [])

    def test_rejects_invalid_or_oversized_upstream_json(self):
        cases = (
            (json.dumps(["not", "an", "object"]).encode(), {"Content-Type": "application/json"}),
            (
                b"",
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(driver_proxy.MAX_JSON_RESPONSE_BYTES + 1),
                },
            ),
            (b'{"ok":true}', {"Content-Type": "text/plain"}),
        )
        for body, headers in cases:
            with self.subTest(headers=headers):
                _LocalDriverHandler.response_body = body
                _LocalDriverHandler.response_headers = headers
                result = driver_proxy.get_driver("capsule_1", "cloudflare-r2")
                self.assertEqual(result, driver_proxy.ProxyResponse(502, {"detail": "capsule-driver unavailable"}))

    def test_transport_log_never_contains_payload_token_or_exception_text(self):
        payload_marker = "payload-secret-marker"
        self.token_file.write_text("bearer-secret-marker", encoding="utf-8")
        with (
            mock.patch.object(driver_proxy, "_endpoint", side_effect=OSError("exception-secret-marker")),
            self.assertLogs("shimpz-admin", level="WARNING") as captured,
        ):
            result = driver_proxy.create_credential(
                "capsule_1", "cloudflare-r2", {"values": {"secret_access_key": payload_marker}}
            )
        rendered = "\n".join(captured.output)
        self.assertEqual(result.status, 502)
        self.assertNotIn(payload_marker, rendered)
        self.assertNotIn("bearer-secret-marker", rendered)
        self.assertNotIn("exception-secret-marker", rendered)

    def test_proxy_module_has_no_admin_persistence_imports(self):
        tree = ast.parse((ROOT / "backend" / "driver_proxy.py").read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertTrue({"envfile", "keyset", "adminstore"}.isdisjoint(imported))


if __name__ == "__main__":
    unittest.main()
