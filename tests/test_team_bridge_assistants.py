"""Live functional and security contracts for the local Assistant control plane."""

from __future__ import annotations

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
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from mfa_helper import configure_supervisor
from team import bridge as team
from team import transport

LOCAL_TEAM_RESIDUES = [
    "assistant_containers",
    "brain_checkpoints",
    "chat_continuations",
    "egress_policies",
    "inference_configuration",
    "integration_credentials",
    "action_checkpoints",
    "publication_bindings",
    "runtime_state",
    "team_networks",
    "team_storage",
]


class _TeamHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []
    response_by_route: ClassVar[dict[tuple[str, str], tuple[int, bytes]]] = {}
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
        status, response_body = self.__class__.response_by_route.get(
            (self.command, self.path),
            (self.__class__.response_status, self.__class__.response_body),
        )
        self.send_response(status)
        headers = dict(self.__class__.response_headers)
        headers.setdefault("Content-Length", str(len(response_body)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if response_body:
            self.wfile.write(response_body)

    do_GET = _handle
    do_POST = _handle
    do_DELETE = _handle


class _LiveTeamCase(unittest.TestCase):
    """Give each contract a real loopback Team endpoint and real bearer file."""

    def setUp(self):
        _TeamHandler.requests = []
        _TeamHandler.response_by_route = {}
        _TeamHandler.response_status = 200
        _TeamHandler.response_body = b'{"ok":true}'
        _TeamHandler.response_headers = {"Content-Type": "application/json"}
        _TeamHandler.response_delay_seconds = 0.0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _TeamHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.token_file = self.root / "team.token"
        self.token_file.write_text("internal-test-bearer\n", encoding="utf-8")
        self.team_url = f"http://127.0.0.1:{self.server.server_port}"

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
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_TEAM_URL": self.team_url,
                "SHIMPZ_TEAM_TOKEN_FILE": str(self.token_file),
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


class TeamAssistantBridgeTest(_LiveTeamCase):
    def test_team_id_transliterates_latin_names_before_canonicalizing(self):
        cases = {
            "Gestão": "gestao",
            "Ação & Operações": "acao_operacoes",
            "Straße Europa": "strasse_europa",
            "Bjørn & Łukasz": "bjorn_lukasz",
            "Œuvre Ægir": "oeuvre_aegir",
            "Kayık Þór": "kayik_thor",
        }
        for team_name, expected in cases.items():
            with self.subTest(team_name=team_name):
                self.assertEqual(team.to_team_id(team_name), expected)

    def setUp(self):
        super().setUp()
        self.original_token_file = transport.TOKEN_FILE
        self.original_url = transport.URL
        transport.TOKEN_FILE = str(self.token_file)
        transport.URL = self.team_url
        self.addCleanup(self._restore_bridge_config)

    def _restore_bridge_config(self):
        transport.TOKEN_FILE = self.original_token_file
        transport.URL = self.original_url

    def test_forwards_only_the_fixed_assistant_routes_with_existing_bearer(self):
        team.list_assistants()
        team.list_local_assistants()
        team.list_installed_assistants("team_1")
        team.install_assistant(
            "team_1",
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
        )
        team.uninstall_assistant("team_1", "hello-pulse")
        team.install_local_assistant("team_1", {"image_id": "sha256:" + ("b" * 64)})

        self.assertEqual(
            [(item["method"], item["path"]) for item in _TeamHandler.requests],
            [
                ("GET", "/v1/assistants"),
                ("GET", "/v1/local-assistants"),
                ("GET", "/v1/teams/team_1/assistants"),
                ("POST", "/v1/teams/team_1/assistants"),
                ("DELETE", "/v1/teams/team_1/assistants/hello-pulse"),
                ("POST", "/v1/teams/team_1/assistants/local"),
            ],
        )
        self.assertEqual(
            json.loads(_TeamHandler.requests[3]["body"]),
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
        )
        self.assertEqual(
            json.loads(_TeamHandler.requests[5]["body"]),
            {"image_id": "sha256:" + ("b" * 64)},
        )
        for request in _TeamHandler.requests:
            self.assertEqual(request["headers"]["accept"], "application/json")
            self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")
        self.assertNotIn("content-type", _TeamHandler.requests[0]["headers"])

    def test_preserves_safe_team_status_and_body(self):
        _TeamHandler.response_status = 409
        _TeamHandler.response_body = b'{"detail":"assistant already installed"}'

        response = team.install_assistant(
            "team_1",
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
        )

        self.assertEqual(
            response,
            team.TeamResponse(409, {"detail": "assistant already installed"}),
        )

    def test_install_uses_its_full_lifecycle_timeout_budget(self):
        with mock.patch.object(team, "_call", return_value=team.TeamResponse(200, {})) as call:
            team.install_assistant(
                "team_1",
                {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
            )

        call.assert_called_once_with(
            "POST",
            "/v1/teams/team_1/assistants",
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
            timeout=team.ASSISTANT_INSTALL_TIMEOUT_SECONDS,
        )
        self.assertGreater(team.ASSISTANT_INSTALL_TIMEOUT_SECONDS, team.CONTROL_TIMEOUT_SECONDS)

    def test_fetches_an_installed_assistant_icon_as_bounded_png(self):
        icon = b"\x89PNG\r\n\x1a\ncanonical"
        _TeamHandler.response_headers = {"Content-Type": "image/png"}
        _TeamHandler.response_body = icon

        response = team.assistant_icon("team_1", "hello-pulse")

        self.assertEqual(response, team.TeamAssetResponse(200, icon, {}))
        request = _TeamHandler.requests[-1]
        self.assertEqual(request["path"], "/v1/teams/team_1/assistants/hello-pulse/icon")
        self.assertEqual(request["headers"]["accept"], "image/png")

    def test_rejects_an_invalid_assistant_icon_response(self):
        _TeamHandler.response_headers = {"Content-Type": "application/octet-stream"}
        _TeamHandler.response_body = b"not an admitted icon"

        response = team.assistant_icon("team_1", "hello-pulse")

        self.assertEqual(
            response,
            team.TeamAssetResponse(502, None, {"detail": "team unavailable"}),
        )

    def test_destroy_requires_the_authoritative_name_and_forwards_no_confirmation_secret(self):
        _TeamHandler.response_by_route = {
            (
                "GET",
                "/v1/teams",
            ): (
                200,
                json.dumps(
                    {
                        "teams": [{"team_id": "team_1", "team_name": "Marketing", "status": "running"}],
                        "trace_id": "a" * 32,
                    },
                    separators=(",", ":"),
                ).encode(),
            ),
            (
                "DELETE",
                "/v1/teams/team_1",
            ): (
                200,
                json.dumps(
                    {
                        "team_id": "team_1",
                        "destroyed": True,
                        "assistants_removed": 1,
                        "residue_absent": LOCAL_TEAM_RESIDUES,
                        "storage_removed": True,
                    },
                    separators=(",", ":"),
                ).encode(),
            ),
        }

        with self.assertRaisesRegex(team.TeamRequestError, "Team name confirmation does not match"):
            team.destroy("team_1", "Not Marketing")
        response = team.destroy("team_1", "Marketing")

        self.assertEqual(response.status, 200)
        self.assertEqual(
            [(request["method"], request["path"]) for request in _TeamHandler.requests],
            [
                ("GET", "/v1/teams"),
                ("GET", "/v1/teams"),
                ("DELETE", "/v1/teams/team_1"),
            ],
        )
        deleted = _TeamHandler.requests[-1]
        self.assertEqual(deleted["body"], b"")
        self.assertNotIn("content-type", deleted["headers"])

    def test_destroy_rejects_an_ambiguous_inventory_before_delete(self):
        _TeamHandler.response_body = json.dumps(
            {
                "teams": [{"team_id": "team_1", "team_name": "Marketing", "status": "running", "extra": True}],
            },
            separators=(",", ":"),
        ).encode()

        response = team.destroy("team_1", "Marketing")

        self.assertEqual(response, team.TeamResponse(502, {"detail": "Team inventory response is invalid."}))
        self.assertEqual(
            [(request["method"], request["path"]) for request in _TeamHandler.requests],
            [("GET", "/v1/teams")],
        )

    def test_storage_bridge_forwards_only_opaque_metadata_and_fixed_routes(self):
        content = b"Team private data"
        file_id = "b" * 32
        metadata = {
            "id": file_id,
            "name": "brief.txt",
            "media_type": "text/plain",
            "size": len(content),
            "sha256": "a" * 64,
            "created_at": 1_700_000_000,
        }
        usage = {
            "used_bytes": len(content),
            "limit_bytes": 100 * 1024 * 1024,
            "remaining_bytes": 100 * 1024 * 1024 - len(content),
        }
        _TeamHandler.response_body = json.dumps(
            {
                "team_id": "team_1",
                "file": {**metadata, **usage, "path": "/private/never-expose"},
                "path": "/private/never-expose",
            },
            separators=(",", ":"),
        ).encode()

        uploaded = team.upload_file("team_1", "brief.txt", "text/plain", content)

        self.assertEqual(
            uploaded,
            team.TeamResponse(200, {"team_id": "team_1", "file": metadata, **usage}),
        )
        upload_request = _TeamHandler.requests[-1]
        self.assertEqual(
            (upload_request["method"], upload_request["path"]),
            ("POST", "/v1/teams/team_1/files"),
        )
        self.assertEqual(upload_request["body"], content)
        self.assertEqual(upload_request["headers"]["content-type"], "text/plain")
        self.assertEqual(upload_request["headers"]["x-shimpz-filename"], "brief.txt")
        self.assertEqual(upload_request["headers"]["content-length"], str(len(content)))

        _TeamHandler.response_body = json.dumps(
            {"team_id": "team_1", "files": [{**metadata, "path": "/private/no"}], **usage},
            separators=(",", ":"),
        ).encode()
        listed = team.list_files("team_1")
        self.assertEqual(
            listed,
            team.TeamResponse(200, {"team_id": "team_1", "files": [metadata], **usage}),
        )

        _TeamHandler.response_body = json.dumps(
            {"team_id": "team_1", "id": file_id, "deleted": True, **usage},
            separators=(",", ":"),
        ).encode()
        deleted = team.delete_file("team_1", file_id)
        self.assertEqual(
            deleted,
            team.TeamResponse(
                200,
                {"team_id": "team_1", "id": file_id, "deleted": True, **usage},
            ),
        )

        self.assertEqual(
            [(request["method"], request["path"]) for request in _TeamHandler.requests],
            [
                ("POST", "/v1/teams/team_1/files"),
                ("GET", "/v1/teams/team_1/files"),
                ("DELETE", f"/v1/teams/team_1/files/{file_id}"),
            ],
        )
        for request in _TeamHandler.requests:
            self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")

    def test_storage_projection_keeps_over_quota_cleanup_visible(self):
        response = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "files": [],
                "used_bytes": 8,
                "limit_bytes": 4,
                "remaining_bytes": 0,
            },
        )

        self.assertEqual(
            team._project_storage_response(response, team_id="team_1", kind="list"),
            response,
        )

    def test_storage_bridge_rejects_paths_and_non_opaque_ids_before_network_access(self):
        invalid = (
            lambda: team.upload_file("team_1", "../brief.txt", "text/plain", b"data"),
            lambda: team.upload_file("team_1", "brief.txt", "text/plain", b""),
            lambda: team.delete_file("team_1", "../not-an-id"),
        )
        for action in invalid:
            with self.subTest(action=action), self.assertRaises(team.TeamRequestError):
                action()
        self.assertEqual(_TeamHandler.requests, [])

    def test_storage_bridge_preserves_safe_error_status_without_internal_fields(self):
        _TeamHandler.response_status = 507
        _TeamHandler.response_body = b'{"detail":"Team storage quota exceeded","path":"/private/no"}'

        response = team.upload_file("team_1", "brief.txt", "text/plain", b"data")

        self.assertEqual(
            response,
            team.TeamResponse(507, {"detail": "Team storage quota exceeded"}),
        )

    def test_rejects_invalid_assistant_paths_and_input_before_network_access(self):
        invalid = (
            lambda: team.list_installed_assistants("Team_1"),
            lambda: team.install_assistant(
                "team_1",
                {"assistant_id": "../hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
            ),
            lambda: team.install_assistant(
                "team_1",
                {
                    "assistant_id": "hello-pulse",
                    "source_digest": "sha256:" + ("a" * 64),
                    "extra": True,
                },
            ),
            lambda: team.uninstall_assistant("team_1", "../hello-pulse"),
        )
        for action in invalid:
            with self.subTest(action=action), self.assertRaises(team.TeamRequestError):
                action()
        self.assertEqual(_TeamHandler.requests, [])

    def test_invalid_or_oversized_team_json_fails_closed(self):
        cases = (
            (b'["not-an-object"]', {"Content-Type": "application/json"}),
            (b'{"ok":true}', {"Content-Type": "text/plain"}),
            (
                b"",
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(team.MAX_JSON_RESPONSE_BYTES + 1),
                },
            ),
        )
        for body, headers in cases:
            with self.subTest(headers=headers):
                _TeamHandler.response_body = body
                _TeamHandler.response_headers = headers
                self.assertEqual(
                    team.list_assistants(),
                    team.TeamResponse(502, {"detail": "team unavailable"}),
                )


class TeamAssistantRouteTest(_LiveTeamCase):
    def test_exposes_only_session_gated_assistant_routes(self):
        document = self._run_asgi_probe("routes")

        self.assertTrue(document["routes_ok"])
        self.assertTrue(document["closed_api_ok"])
        self.assertTrue(document["retired_operations_absent"])
        self.assertTrue(document["action_routes_absent"])
        self.assertTrue(document["help_route_absent"])
        self.assertEqual(document["action_status"], 404)
        self.assertEqual(document["help_status"], 404)
        self.assertEqual(document["anonymous_status"], 401)
        self.assertEqual(document["anonymous_body"], {"detail": "unauthenticated"})
        self.assertEqual(_TeamHandler.requests, [])

    def test_install_route_preserves_conflict_and_forwards_exact_body(self):
        _TeamHandler.response_status = 409
        _TeamHandler.response_body = b'{"detail":"already installed"}'

        document = self._run_asgi_probe("install-conflict")

        self.assertEqual(document["status"], 409)
        self.assertEqual(document["body"], {"detail": "already installed"})
        self.assertEqual(len(_TeamHandler.requests), 1)
        request = _TeamHandler.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/v1/teams/team_1/assistants")
        self.assertEqual(
            json.loads(request["body"]),
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
        )
        self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")

    def test_create_route_forwards_only_a_typed_team_name(self):
        expected = {
            "team_id": "marketing",
            "team_name": "Marketing",
            "status": "running",
            "created": True,
        }
        _TeamHandler.response_body = json.dumps(expected, separators=(",", ":")).encode()

        document = self._run_asgi_probe("team-create")

        self.assertEqual(document["valid"], {"status": 200, "body": expected})
        self.assertEqual(
            document["unsupported_field"],
            {"status": 400, "body": {"detail": "request body must contain only team_name"}},
        )
        self.assertEqual(
            document["non_string"],
            {"status": 400, "body": {"detail": "team name must be a string"}},
        )
        self.assertEqual(len(_TeamHandler.requests), 1)
        request = _TeamHandler.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/teams/marketing/create"))
        self.assertEqual(json.loads(request["body"]), {"team_name": "Marketing"})
        self.assertEqual(request["headers"]["authorization"], "Bearer internal-test-bearer")

    def test_destroy_route_requires_name_and_password_without_forwarding_either(self):
        _TeamHandler.response_by_route = {
            (
                "GET",
                "/v1/teams",
            ): (200, b'{"teams":[{"team_id":"team_1","team_name":"Marketing","status":"running"}]}'),
            (
                "DELETE",
                "/v1/teams/team_1",
            ): (
                200,
                json.dumps(
                    {
                        "team_id": "team_1",
                        "destroyed": True,
                        "assistants_removed": 1,
                        "residue_absent": LOCAL_TEAM_RESIDUES,
                        "storage_removed": True,
                    },
                    separators=(",", ":"),
                ).encode(),
            ),
        }

        document = self._run_asgi_probe("team-delete")

        self.assertEqual(
            document["malformed"],
            {"status": 400, "body": {"detail": "request body must contain only team_name and password"}},
        )
        self.assertEqual(
            document["wrong_password"],
            {"status": 403, "body": {"detail": "Supervisor password is incorrect"}},
        )
        self.assertEqual(
            document["wrong_name"], {"status": 400, "body": {"detail": "Team name confirmation does not match"}}
        )
        self.assertEqual(document["valid"]["status"], 200)
        self.assertEqual(
            [(request["method"], request["path"]) for request in _TeamHandler.requests],
            [
                ("GET", "/v1/teams"),
                ("GET", "/v1/teams"),
                ("DELETE", "/v1/teams/team_1"),
            ],
        )
        delete_request = _TeamHandler.requests[-1]
        self.assertEqual(delete_request["body"], b"")
        self.assertNotIn("content-type", delete_request["headers"])
        forwarded = b"".join(request["body"] for request in _TeamHandler.requests)
        self.assertNotIn(b"test-admin-password", forwarded)
        self.assertNotIn(b"Marketing", forwarded)

    def test_multipart_upload_is_bounded_and_forwarded_as_raw_bytes_without_a_path(self):
        content = b"Team private data"
        file_id = "b" * 32
        usage = {
            "used_bytes": len(content),
            "limit_bytes": 100 * 1024 * 1024,
            "remaining_bytes": 100 * 1024 * 1024 - len(content),
        }
        _TeamHandler.response_body = json.dumps(
            {
                "team_id": "team_1",
                "file": {
                    "id": file_id,
                    "name": "brief.txt",
                    "media_type": "text/plain",
                    "size": len(content),
                    "sha256": "a" * 64,
                    "created_at": 1_700_000_000,
                    **usage,
                    "path": "/private/never-expose",
                },
            },
            separators=(",", ":"),
        ).encode()

        document = self._run_asgi_probe("file-upload")

        self.assertEqual(document["status"], 200)
        self.assertNotIn("path", document["body"])
        self.assertNotIn("path", document["body"]["file"])
        self.assertEqual(len(_TeamHandler.requests), 1)
        request = _TeamHandler.requests[0]
        self.assertEqual((request["method"], request["path"]), ("POST", "/v1/teams/team_1/files"))
        self.assertEqual(request["body"], content)
        self.assertEqual(request["headers"]["content-type"], "text/plain")
        self.assertEqual(request["headers"]["x-shimpz-filename"], "brief.txt")
        self.assertEqual(request["headers"]["content-length"], str(len(content)))

    def test_multipart_envelope_over_the_limit_stops_before_team_call(self):
        document = self._run_asgi_probe("oversized-file")

        self.assertEqual(document["status"], 413)
        self.assertEqual(document["body"], {"detail": "file upload too large"})
        self.assertEqual(_TeamHandler.requests, [])

    def test_session_responds_while_real_team_holds_install(self):
        _TeamHandler.response_delay_seconds = 1.0

        document = self._run_asgi_probe("concurrent-session")

        self.assertEqual(document["session_status"], 200)
        self.assertTrue(document["session_body"]["authenticated"])
        self.assertTrue(document["install_was_pending"])
        self.assertLess(document["session_elapsed_seconds"], 0.75)
        self.assertEqual(document["install_status"], 200)
        self.assertEqual(len(_TeamHandler.requests), 1)


async def _asgi_request(
    admin_app,
    method: str,
    path: str,
    body: bytes = b"",
    *,
    token: str = "",
    content_type: str | None = None,
    content_length: int | None = None,
):
    """Drive the real FastAPI ASGI stack without an in-process route substitute."""
    declared_length = len(body) if content_length is None else content_length
    headers = [(b"accept", b"application/json"), (b"content-length", str(declared_length).encode())]
    if content_type is not None:
        headers.append((b"content-type", content_type.encode()))
    elif body:
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


def _multipart_file_body(boundary: str, content: bytes) -> bytes:
    return (
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="brief.txt"\r\n'
            "Content-Type: text/plain\r\n"
            "\r\n"
        ).encode()
        + content
        + f"\r\n--{boundary}--\r\n".encode()
    )


def _probe_routes(admin_app, token: str) -> dict[str, object]:
    routes = {
        (route.path, method) for route in admin_app.app.routes for method in (getattr(route, "methods", None) or set())
    }
    expected = {
        ("/api/assistants", "GET"),
        ("/api/assistants/{assistant_id}/catalog-icon", "GET"),
        ("/api/teams/{team_id}", "DELETE"),
        ("/api/teams/{team_id}/assistants", "GET"),
        ("/api/teams/{team_id}/assistants", "POST"),
        ("/api/teams/{team_id}/assistants/{assistant_id}/icon", "GET"),
        ("/api/teams/{team_id}/assistants/{assistant_id}", "DELETE"),
        ("/api/teams/{team_id}/files", "GET"),
        ("/api/teams/{team_id}/files", "POST"),
        ("/api/teams/{team_id}/files/{file_id}", "DELETE"),
    }
    status, body = asyncio.run(_asgi_request(admin_app, "GET", "/api/assistants"))
    action_status, _action_body = asyncio.run(
        _asgi_request(
            admin_app,
            "POST",
            "/api/teams/team_1/assistants/hello-pulse/actions/hello",
            b'{"name":"Supervisor"}',
            token=token,
        )
    )
    help_status, _help_body = asyncio.run(
        _asgi_request(
            admin_app,
            "GET",
            "/api/teams/team_1/assistants/shimpz-cloudflare/help",
            token=token,
        )
    )
    return {
        "routes_ok": expected.issubset(routes),
        "closed_api_ok": all(path not in admin_app.OPEN_API for path, _method in expected),
        "retired_operations_absent": not any("/operations/" in path for path, _method in routes),
        "action_routes_absent": not any("/actions/" in path for path, _method in routes),
        "help_route_absent": (
            "/api/teams/{team_id}/assistants/{assistant_id}/help",
            "GET",
        )
        not in routes,
        "action_status": action_status,
        "help_status": help_status,
        "anonymous_status": status,
        "anonymous_body": body,
    }


def _probe_session():
    import auth
    import state

    import app as admin_app

    secret = configure_supervisor(state, "test-admin-password")
    token = auth.issue_session(secret, "totp")
    return admin_app, token


def _run_asgi_probe(scenario: str) -> None:
    """Fresh-process route probe: real env, store, session, ASGI middleware and HTTP bridge."""
    admin_app, token = _probe_session()

    if scenario == "routes":
        output = _probe_routes(admin_app, token)
    elif scenario == "install-conflict":
        payload = json.dumps(
            {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
            separators=(",", ":"),
        ).encode()
        status, body = asyncio.run(
            _asgi_request(
                admin_app,
                "POST",
                "/api/teams/team_1/assistants",
                payload,
                token=token,
            )
        )
        output = {"status": status, "body": body}
    elif scenario == "team-create":

        async def create_requests():
            results = {}
            for key, payload in (
                ("unsupported_field", {"name": "Marketing"}),
                ("non_string", {"team_name": 123}),
                ("valid", {"team_name": "Marketing"}),
            ):
                status, body = await _asgi_request(
                    admin_app,
                    "POST",
                    "/api/teams",
                    json.dumps(payload, separators=(",", ":")).encode(),
                    token=token,
                )
                results[key] = {"status": status, "body": body}
            return results

        output = asyncio.run(create_requests())
    elif scenario == "team-delete":

        async def delete_requests():
            results = {}
            for key, payload in (
                ("malformed", {"team_name": "Marketing", "password": "test-admin-password", "extra": True}),
                ("wrong_password", {"team_name": "Marketing", "password": "wrong-admin-password"}),
                ("wrong_name", {"team_name": "Not Marketing", "password": "test-admin-password"}),
                ("valid", {"team_name": "Marketing", "password": "test-admin-password"}),
            ):
                status, body = await _asgi_request(
                    admin_app,
                    "DELETE",
                    "/api/teams/team_1",
                    json.dumps(payload, separators=(",", ":")).encode(),
                    token=token,
                )
                results[key] = {"status": status, "body": body}
            return results

        output = asyncio.run(delete_requests())
    elif scenario == "file-upload":
        boundary = "shimpz-admin-upload-boundary"
        payload = _multipart_file_body(boundary, b"Team private data")
        status, body = asyncio.run(
            _asgi_request(
                admin_app,
                "POST",
                "/api/teams/team_1/files",
                payload,
                token=token,
                content_type=f"multipart/form-data; boundary={boundary}",
            )
        )
        output = {"status": status, "body": body}
    elif scenario == "oversized-file":
        boundary = "shimpz-admin-upload-boundary"
        payload = _multipart_file_body(boundary, b"small")
        status, body = asyncio.run(
            _asgi_request(
                admin_app,
                "POST",
                "/api/teams/team_1/files",
                payload,
                token=token,
                content_type=f"multipart/form-data; boundary={boundary}",
                content_length=admin_app.team_files.MAX_MULTIPART_BODY_BYTES + 1,
            )
        )
        output = {"status": status, "body": body}
    elif scenario == "concurrent-session":

        async def concurrent_requests():
            payload = json.dumps(
                {"assistant_id": "hello-pulse", "source_digest": "sha256:" + ("a" * 64)},
                separators=(",", ":"),
            ).encode()
            started = time.monotonic()
            install_task = asyncio.create_task(
                _asgi_request(
                    admin_app,
                    "POST",
                    "/api/teams/team_1/assistants",
                    payload,
                    token=token,
                )
            )
            await asyncio.sleep(0.1)
            session_status, session_body = await asyncio.wait_for(
                _asgi_request(admin_app, "POST", "/api/session", token=token),
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
