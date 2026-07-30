"""Real-HTTP contracts for the private local model-key hand-off."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import team_client

import teams

TRACE_ID = "a" * 32
CHALLENGE_ID = "b" * 32


class _ControllerHandler(BaseHTTPRequestHandler):
    request: ClassVar[dict[str, object]] = {}

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.__class__.request = {
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": self.rfile.read(length),
        }
        body = b'{"team_id":"team_1","team_name":"Marketing","reply":"Hello!","trace_id":"' + TRACE_ID.encode() + b'"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class PrivateChatTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _ControllerHandler)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        self.thread.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.token_file = Path(self.temporary.name) / "token"
        self.token_file.write_text("controller-test-token", encoding="ascii")
        self.previous_url, self.previous_token = team_client.URL, team_client.TOKEN_FILE
        team_client.URL = f"http://127.0.0.1:{self.server.server_port}"
        team_client.TOKEN_FILE = str(self.token_file)

    def tearDown(self) -> None:
        team_client.URL = self.previous_url
        team_client.TOKEN_FILE = self.previous_token
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def test_key_uses_private_header_while_json_remains_team_contract(self) -> None:
        api_key = "sk-test-0123456789"
        teams.chat(
            "team_1",
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
            provider="openai",
            api_key=api_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat")
        self.assertEqual(
            json.loads(request["body"]),
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
        )
        self.assertEqual(request["headers"]["x-shimpz-model-provider"], "openai")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], api_key)
        self.assertNotIn(api_key.encode(), request["body"])

    def test_integration_resume_uses_private_model_header_and_exact_challenge(self) -> None:
        model_key = "sk-test-0123456789"
        teams.resume_chat_integrations(
            "team_1",
            {"challenge_id": CHALLENGE_ID},
            provider="openai",
            api_key=model_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat/integrations")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], model_key)
        self.assertEqual(json.loads(request["body"]), {"challenge_id": CHALLENGE_ID})
        self.assertNotIn(model_key.encode(), request["body"])
