"""Live contracts for the Admin-to-Team OAuth bridge."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from team import bridge as team
from team import transport

from integrations import assistants as integrations


class _TeamHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []
    response_by_route: ClassVar[dict[tuple[str, str], tuple[int, bytes]]] = {}
    response_body = b'{"ok":true}'

    def log_message(self, *_args):
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        self.__class__.requests.append({"method": self.command, "path": self.path, "body": body})
        status, response_body = self.__class__.response_by_route.get(
            (self.command, self.path),
            (200, self.__class__.response_body),
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        if response_body:
            self.wfile.write(response_body)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_DELETE(self):
        self._handle()


class TeamOAuthBridgeTest(unittest.TestCase):
    def setUp(self):
        _TeamHandler.requests = []
        _TeamHandler.response_by_route = {}
        _TeamHandler.response_body = b'{"ok":true}'
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _TeamHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        token_file = Path(self.tempdir.name) / "team.token"
        token_file.write_text("internal-test-bearer\n", encoding="utf-8")
        self.original_token_file = transport.TOKEN_FILE
        self.original_url = transport.URL
        transport.TOKEN_FILE = str(token_file)
        transport.URL = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self._restore_bridge_config)

    def _stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _restore_bridge_config(self):
        transport.TOKEN_FILE = self.original_token_file
        transport.URL = self.original_url

    @staticmethod
    def _authorization_url(**overrides: str) -> str:
        fields = {
            "scope": "dns.read offline_access zone.read",
            "state": "a" * 43,
            "code_challenge": "b" * 43,
            "callback": "hosted",
        }
        fields.update(overrides)
        return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(fields)

    def test_starts_only_fixed_cloudflare_pkce_authorization(self):
        authorization_url = self._authorization_url()
        _TeamHandler.response_body = json.dumps(
            {"authorization_url": authorization_url, "trace_id": "f" * 32},
            separators=(",", ":"),
        ).encode()

        response = integrations.start_local_assistant_integration_authorization(
            "team_1",
            "c" * 32,
            "d" * 43,
            "hosted",
        )

        self.assertEqual(response, team.TeamResponse(200, {"authorization_url": authorization_url}))
        request = _TeamHandler.requests[-1]
        self.assertEqual(
            request["path"],
            "/v1/teams/team_1/assistant-integrations/challenges/" + "c" * 32 + "/authorize",
        )
        self.assertEqual(
            json.loads(request["body"]),
            {"callback_mode": "hosted", "session_binding": "d" * 43},
        )
        self.assertNotRegex(bytes(request["body"]).decode(), r"token|code|verifier|client")

        for invalid_url in (
            self._authorization_url(scope="dns.read zone.read"),
            self._authorization_url(state="short"),
            self._authorization_url() + "&state=duplicate",
            self._authorization_url().replace("https://shimpz.com/", "https://shimpz.com.evil.example/"),
            self._authorization_url() + "#access_token=must-not-cross",
            self._authorization_url(callback="loopback"),
        ):
            _TeamHandler.response_body = json.dumps(
                {"authorization_url": invalid_url, "trace_id": "f" * 32},
                separators=(",", ":"),
            ).encode()
            invalid = integrations.start_local_assistant_integration_authorization(
                "team_1", "c" * 32, "d" * 43, "hosted"
            )
            self.assertEqual(
                invalid,
                team.TeamResponse(502, {"detail": "OAuth authorization response is invalid."}),
            )

        with self.assertRaisesRegex(team.TeamRequestError, "callback mode"):
            integrations.start_local_assistant_integration_authorization(
                "team_1", "c" * 32, "d" * 43, "https://evil.example"
            )

        for invalid_envelope in (
            {"authorization_url": authorization_url},
            {"authorization_url": authorization_url, "trace_id": "short"},
            {"authorization_url": authorization_url, "trace_id": "f" * 32, "token": "must-not-cross"},
        ):
            _TeamHandler.response_body = json.dumps(invalid_envelope, separators=(",", ":")).encode()
            invalid = integrations.start_local_assistant_integration_authorization(
                "team_1", "c" * 32, "d" * 43, "hosted"
            )
            self.assertEqual(
                invalid,
                team.TeamResponse(502, {"detail": "OAuth authorization response is invalid."}),
            )

    def test_disconnect_and_callback_forward_only_fixed_private_contracts(self):
        _TeamHandler.response_by_route = {
            (
                "DELETE",
                "/v1/teams/team_1/assistant-integrations/shimpz-cloudflare/x-integration",
            ): (200, b'{"disconnected":true,"trace_id":"ffffffffffffffffffffffffffffffff"}'),
            (
                "POST",
                "/v1/oauth/cloudflare/callback",
            ): (
                200,
                b'{"connected":true,"team_id":"team_1","assistant_id":"shimpz-cloudflare","integration_id":"x-integration","trace_id":"ffffffffffffffffffffffffffffffff"}',
            ),
        }

        disconnected = integrations.disconnect_assistant_integration("team_1", "shimpz-cloudflare", "x-integration")
        completed = integrations.complete_cloudflare_oauth_callback(
            state="a" * 43,
            claim="c" * 64,
            session_binding="b" * 43,
        )

        self.assertEqual(disconnected, team.TeamResponse(204, {}))
        self.assertEqual(
            completed,
            team.TeamResponse(
                200,
                {
                    "connected": True,
                    "team_id": "team_1",
                    "assistant_id": "shimpz-cloudflare",
                    "integration_id": "x-integration",
                },
            ),
        )
        callback = _TeamHandler.requests[-1]
        self.assertEqual(callback["path"], "/v1/oauth/cloudflare/callback")
        self.assertEqual(
            json.loads(callback["body"]),
            {
                "state": "a" * 43,
                "claim": "c" * 64,
                "session_binding": "b" * 43,
            },
        )


if __name__ == "__main__":
    unittest.main()
