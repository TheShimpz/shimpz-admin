"""Real-HTTP contracts for the private local model-key hand-off."""

from __future__ import annotations

import contextlib
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

from team import bridge as team
from team import transport

from protocol.http.v1 import progress as progress_contract

TRACE_ID = "a" * 32
CHALLENGE_ID = "b" * 32


class _ControllerHandler(BaseHTTPRequestHandler):
    request: ClassVar[dict[str, object]] = {}
    response_mode: ClassVar[str] = "valid"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.__class__.request = {
            "path": self.path,
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": self.rfile.read(length),
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        records = [
            {"type": "progress", "seq": 1, "phase": "team-context", "state": "started"},
            {
                "type": "progress",
                "seq": 2,
                "phase": "team-context",
                "state": "finished",
                "elapsed_ms": 3,
            },
            {
                "type": "terminal",
                "status": 200,
                "body": {
                    "team_id": "team_1",
                    "team_name": "Marketing",
                    "reply": "Hello!",
                    "trace_id": TRACE_ID,
                },
            },
        ]
        if self.response_mode == "sequence-gap":
            records[0]["seq"] = 2
        elif self.response_mode == "missing-terminal":
            records.pop()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            for record in records:
                encoded = progress_contract.encode_record(record)
                self.wfile.write(f"{len(encoded):X}\r\n".encode("ascii") + encoded + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()


class PrivateChatTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        _ControllerHandler.response_mode = "valid"
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
        self.previous_url, self.previous_token = transport.URL, transport.TOKEN_FILE
        transport.URL = f"http://127.0.0.1:{self.server.server_port}"
        transport.TOKEN_FILE = str(self.token_file)

    def tearDown(self) -> None:
        transport.URL = self.previous_url
        transport.TOKEN_FILE = self.previous_token
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def test_key_uses_private_header_while_json_remains_team_contract(self) -> None:
        api_key = "sk-test-0123456789"
        progress: list[dict[str, object]] = []
        team.chat(
            "team_1",
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
            provider="openai",
            api_key=api_key,
            progress=progress.append,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat")
        self.assertEqual(
            json.loads(request["body"]),
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
        )
        self.assertEqual(request["headers"]["x-shimpz-model-provider"], "openai")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], api_key)
        self.assertEqual(request["headers"]["accept"], "application/x-ndjson")
        self.assertNotIn(api_key.encode(), request["body"])
        self.assertEqual(
            progress,
            [
                {"seq": 1, "phase": "team-context", "state": "started"},
                {
                    "seq": 2,
                    "phase": "team-context",
                    "state": "finished",
                    "elapsed_ms": 3,
                },
            ],
        )

    def test_integration_resume_uses_private_model_header_and_exact_challenge(self) -> None:
        model_key = "sk-test-0123456789"
        team.resume_chat_integrations(
            "team_1",
            {"challenge_id": CHALLENGE_ID},
            provider="openai",
            api_key=model_key,
            progress=lambda _event: None,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat/integrations")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], model_key)
        self.assertEqual(json.loads(request["body"]), {"challenge_id": CHALLENGE_ID})
        self.assertNotIn(model_key.encode(), request["body"])

    def test_malformed_or_truncated_stream_fails_closed(self) -> None:
        for mode in ("sequence-gap", "missing-terminal"):
            with self.subTest(mode=mode):
                _ControllerHandler.response_mode = mode
                events: list[dict[str, object]] = []
                response = team.chat(
                    "team_1",
                    {"message": "Hello", "files": [], "assistant_ids": []},
                    provider="openai",
                    api_key="sk-test-0123456789",
                    progress=events.append,
                )
                self.assertEqual(response, team.TeamResponse(502, {"detail": "team unavailable"}))
                if mode == "sequence-gap":
                    self.assertEqual(events, [])
