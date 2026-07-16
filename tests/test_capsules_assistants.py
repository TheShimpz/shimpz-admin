"""Live functional and security contracts for the local Assistant control plane."""

from __future__ import annotations

import ast
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import capsules


class _DriverHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []
    response_status = 200
    response_body = b'{"ok":true}'
    response_headers: ClassVar[dict[str, str]] = {"Content-Type": "application/json"}
    response_delay_seconds = 0.0

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
        if self.__class__.response_delay_seconds:
            time.sleep(self.__class__.response_delay_seconds)
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
    do_DELETE = _handle


class _LiveDriverCase(unittest.TestCase):
    """Give each contract a real loopback driver and real bearer file."""

    def setUp(self):
        _DriverHandler.requests = []
        _DriverHandler.response_status = 200
        _DriverHandler.response_body = b'{"ok":true}'
        _DriverHandler.response_headers = {"Content-Type": "application/json"}
        _DriverHandler.response_delay_seconds = 0.0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _DriverHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.token_file = self.root / "capsule-driver.token"
        self.token_file.write_text("internal-test-bearer\n", encoding="utf-8")
        self.driver_url = f"http://127.0.0.1:{self.server.server_port}"

    def _stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _run_asgi_probe(self, scenario: str) -> dict[str, object]:
        env = os.environ.copy()
        env.update(
            {
                "PYTHONPATH": str(ROOT / "backend"),
                "SHIMPZ_REPO": str(self.root),
                "SHIMPZ_ADMIN_STORE": str(self.root / "admin.json"),
                "SHIMPZ_CAPSULEDRIVER_URL": self.driver_url,
                "SHIMPZ_CAPSULEDRIVER_TOKEN_FILE": str(self.token_file),
                "SHIMPZ_SETUP_TOKEN": "",
            }
        )
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--asgi-probe", scenario],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            self.fail(f"ASGI probe {scenario!r} failed:\n{result.stdout}\n{result.stderr}")
        try:
            document = json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"ASGI probe {scenario!r} returned invalid JSON:\n{result.stdout}\n{result.stderr}")
        self.assertIsInstance(document, dict)
        return document


class CapsuleAssistantBridgeTest(_LiveDriverCase):
    def setUp(self):
        super().setUp()
        self.original_token_file = capsules.TOKEN_FILE
        self.original_url = capsules.URL
        capsules.TOKEN_FILE = str(self.token_file)
        capsules.URL = self.driver_url
        self.addCleanup(self._restore_bridge_config)

    def _restore_bridge_config(self):
        capsules.TOKEN_FILE = self.original_token_file
        capsules.URL = self.original_url

    def test_forwards_only_the_fixed_assistant_routes_with_existing_bearer(self):
        capsules.list_assistants()
        capsules.list_installed_assistants("capsule_1")
        capsules.install_assistant("capsule_1", {"assistant": "hello-pulse"})
        capsules.invoke_assistant_operation("capsule_1", "hello-pulse", "hello", {"name": "Captain"})
        capsules.uninstall_assistant("capsule_1", "hello-pulse")

        self.assertEqual(
            [(item["method"], item["path"]) for item in _DriverHandler.requests],
            [
                ("GET", "/v1/assistants"),
                ("GET", "/v1/capsules/capsule_1/assistants"),
                ("POST", "/v1/capsules/capsule_1/assistants"),
                ("POST", "/v1/capsules/capsule_1/assistants/hello-pulse/operations/hello"),
                ("DELETE", "/v1/capsules/capsule_1/assistants/hello-pulse"),
            ],
        )
        self.assertEqual(json.loads(_DriverHandler.requests[2]["body"]), {"assistant": "hello-pulse"})
        self.assertEqual(json.loads(_DriverHandler.requests[3]["body"]), {"name": "Captain"})
        for request in _DriverHandler.requests:
            self.assertEqual(request["headers"]["accept"], "application/json")
            self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")
        self.assertNotIn("content-type", _DriverHandler.requests[0]["headers"])

    def test_preserves_safe_driver_status_and_body(self):
        _DriverHandler.response_status = 409
        _DriverHandler.response_body = b'{"detail":"assistant already installed"}'

        response = capsules.install_assistant("capsule_1", {"assistant": "hello-pulse"})

        self.assertEqual(
            response,
            capsules.DriverResponse(409, {"detail": "assistant already installed"}),
        )

    def test_rejects_unknown_paths_operations_and_input_before_network_access(self):
        invalid = (
            lambda: capsules.list_installed_assistants("Capsule_1"),
            lambda: capsules.install_assistant("capsule_1", {"assistant": "../hello-pulse"}),
            lambda: capsules.install_assistant("capsule_1", {"assistant": "hello-pulse", "extra": True}),
            lambda: capsules.invoke_assistant_operation(
                "capsule_1", "hello-pulse", "delete-everything", {"name": "Captain"}
            ),
            lambda: capsules.invoke_assistant_operation(
                "capsule_1", "hello-pulse", "hello", {"name": "Captain", "command": "whoami"}
            ),
            lambda: capsules.invoke_assistant_operation("capsule_1", "hello-pulse", "hello", {"name": "x" * 81}),
        )
        for operation in invalid:
            with self.subTest(operation=operation), self.assertRaises(capsules.CapsuleRequestError):
                operation()
        self.assertEqual(_DriverHandler.requests, [])

    def test_invalid_or_oversized_driver_json_fails_closed(self):
        cases = (
            (b'["not-an-object"]', {"Content-Type": "application/json"}),
            (b'{"ok":true}', {"Content-Type": "text/plain"}),
            (
                b"",
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(capsules.MAX_JSON_RESPONSE_BYTES + 1),
                },
            ),
        )
        for body, headers in cases:
            with self.subTest(headers=headers):
                _DriverHandler.response_body = body
                _DriverHandler.response_headers = headers
                self.assertEqual(
                    capsules.list_assistants(),
                    capsules.DriverResponse(502, {"detail": "capsule-driver unavailable"}),
                )

    def test_bridge_has_no_docker_or_process_execution_dependency(self):
        tree = ast.parse((ROOT / "backend" / "capsules.py").read_text(encoding="utf-8"))
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module.split(".")[0])
        self.assertTrue({"docker", "subprocess"}.isdisjoint(imports))


class CapsuleAssistantRouteTest(_LiveDriverCase):
    def test_exposes_only_session_gated_assistant_routes(self):
        document = self._run_asgi_probe("routes")

        self.assertTrue(document["routes_ok"])
        self.assertTrue(document["closed_api_ok"])
        self.assertEqual(document["anonymous_status"], 401)
        self.assertEqual(document["anonymous_body"], {"detail": "unauthenticated"})
        self.assertEqual(_DriverHandler.requests, [])

    def test_install_route_preserves_conflict_and_forwards_exact_body(self):
        _DriverHandler.response_status = 409
        _DriverHandler.response_body = b'{"detail":"already installed"}'

        document = self._run_asgi_probe("install-conflict")

        self.assertEqual(document["status"], 409)
        self.assertEqual(document["body"], {"detail": "already installed"})
        self.assertEqual(len(_DriverHandler.requests), 1)
        request = _DriverHandler.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/v1/capsules/capsule_1/assistants")
        self.assertEqual(json.loads(request["body"]), {"assistant": "hello-pulse"})
        self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")

    def test_operation_body_is_bounded_before_driver_call(self):
        document = self._run_asgi_probe("oversized-operation")

        self.assertEqual(document["status"], 413)
        self.assertEqual(document["body"], {"detail": "request body too large"})
        self.assertEqual(_DriverHandler.requests, [])

    def test_session_responds_while_real_driver_holds_install(self):
        _DriverHandler.response_delay_seconds = 1.0

        document = self._run_asgi_probe("concurrent-session")

        self.assertEqual(document["session_status"], 200)
        self.assertTrue(document["session_body"]["authenticated"])
        self.assertTrue(document["install_was_pending"])
        self.assertLess(document["session_elapsed_seconds"], 0.75)
        self.assertEqual(document["install_status"], 200)
        self.assertEqual(len(_DriverHandler.requests), 1)


async def _asgi_request(admin_app, method: str, path: str, body: bytes = b"", *, token: str = ""):
    """Drive the real FastAPI ASGI stack without an in-process route substitute."""
    headers = [(b"accept", b"application/json"), (b"content-length", str(len(body)).encode())]
    if body:
        headers.append((b"content-type", b"application/json"))
    if token:
        headers.append((b"cookie", f"{admin_app.COOKIE}={token}".encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.5"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }
    first_receive = True

    async def receive():
        nonlocal first_receive
        if first_receive:
            first_receive = False
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.Event().wait()
        raise AssertionError("unreachable receive state")

    messages = []

    async def send(message):
        messages.append(message)

    await asyncio.wait_for(admin_app.app(scope, receive, send), timeout=5)
    start = next(message for message in messages if message["type"] == "http.response.start")
    raw_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], json.loads(raw_body or b"{}")


def _run_asgi_probe(scenario: str) -> None:
    """Fresh-process route probe: real env, store, session, ASGI middleware and HTTP bridge."""
    import adminstore
    import app as admin_app
    import auth

    adminstore.set_password("test-admin-password")
    token = auth.issue_session(adminstore.get()["session_secret"])

    if scenario == "routes":
        routes = {(route.path, method) for route in admin_app.app.routes for method in (route.methods or set())}
        expected = {
            ("/api/assistants", "GET"),
            ("/api/capsules/{cid}/assistants", "GET"),
            ("/api/capsules/{cid}/assistants", "POST"),
            ("/api/capsules/{cid}/assistants/{assistant_id}/operations/{operation}", "POST"),
            ("/api/capsules/{cid}/assistants/{assistant_id}", "DELETE"),
        }
        status, body = asyncio.run(_asgi_request(admin_app, "GET", "/api/assistants"))
        output = {
            "routes_ok": expected.issubset(routes),
            "closed_api_ok": all(path not in admin_app.OPEN_API for path, _method in expected),
            "anonymous_status": status,
            "anonymous_body": body,
        }
    elif scenario == "install-conflict":
        payload = json.dumps({"assistant": "hello-pulse"}, separators=(",", ":")).encode()
        status, body = asyncio.run(
            _asgi_request(
                admin_app,
                "POST",
                "/api/capsules/capsule_1/assistants",
                payload,
                token=token,
            )
        )
        output = {"status": status, "body": body}
    elif scenario == "oversized-operation":
        payload = b'{"name":"' + b"x" * capsules.MAX_JSON_BODY_BYTES + b'"}'
        status, body = asyncio.run(
            _asgi_request(
                admin_app,
                "POST",
                "/api/capsules/capsule_1/assistants/hello-pulse/operations/hello",
                payload,
                token=token,
            )
        )
        output = {"status": status, "body": body}
    elif scenario == "concurrent-session":

        async def concurrent_requests():
            payload = json.dumps({"assistant": "hello-pulse"}, separators=(",", ":")).encode()
            started = time.monotonic()
            install_task = asyncio.create_task(
                _asgi_request(
                    admin_app,
                    "POST",
                    "/api/capsules/capsule_1/assistants",
                    payload,
                    token=token,
                )
            )
            await asyncio.sleep(0.1)
            session_status, session_body = await asyncio.wait_for(
                _asgi_request(admin_app, "GET", "/api/session", token=token),
                timeout=0.5,
            )
            install_was_pending = not install_task.done()
            session_elapsed_seconds = time.monotonic() - started
            install_status, _install_body = await install_task
            return {
                "session_status": session_status,
                "session_body": session_body,
                "install_was_pending": install_was_pending,
                "session_elapsed_seconds": session_elapsed_seconds,
                "install_status": install_status,
            }

        output = asyncio.run(concurrent_requests())
    else:
        raise SystemExit(f"unknown ASGI probe: {scenario}")
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe(sys.argv[2])
    else:
        unittest.main()
