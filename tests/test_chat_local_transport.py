"""Real-HTTP contracts for the private local model-key hand-off."""

import contextlib
import copy
import json
import sys
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import supervisor as local_supervisor
from admin_http import serve_loopback
from team import bridge as team
from team import transport

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import progress as progress_contract

TRACE_ID = "a" * 32
CHALLENGE_ID = "b" * 32


REQUEST = {"issued_at": 1_700_000_000, "nonce": "0" * 32}


# The stream's bound in these tests, and a silence longer than it: after which record each silent mode goes quiet.
STREAM_SECONDS = 1
SILENCE_SECONDS = 1.6
SILENT = {"silent-browser": 0, "silent-after-browser": 1, "silent-context": 0}


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
        self.send_header("Connection", "close")
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
                    "clarification": None,
                    "trace_id": TRACE_ID,
                },
            },
        ]
        if self.response_mode == "sequence-gap":
            records[0]["seq"] = 2
        elif self.response_mode == "missing-terminal":
            records.pop()
        elif self.response_mode in SILENT:
            # A Browser phase, then a silence longer than the stream's own bound: during the phase, or after it.
            phase = "browser" if self.response_mode != "silent-context" else "team-context"
            records[0]["phase"] = records[1]["phase"] = phase
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            for index, record in enumerate(records):
                encoded = progress_contract.encode_record(record)
                self.wfile.write(f"{len(encoded):X}\r\n".encode("ascii") + encoded + b"\r\n")
                self.wfile.flush()
                if SILENT.get(self.response_mode) == index:
                    time.sleep(SILENCE_SECONDS)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()


class PrivateChatTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        _ControllerHandler.response_mode = "valid"
        team_url = serve_loopback(self, _ControllerHandler)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.token_file = Path(self.temporary.name) / "token"
        self.token_file.write_text("controller-test-token", encoding="ascii")
        self.enterContext(mock.patch.object(transport, "URL", team_url))
        self.enterContext(mock.patch.object(transport, "TOKEN_FILE", str(self.token_file)))

    def test_key_uses_private_header_while_json_remains_team_contract(self) -> None:
        api_key = "sk-test-0123456789"
        progress: list[dict[str, object]] = []
        payload = {
            "message": "Hello",
            "files": [],
            "assistant_ids": ["shimpz-cloudflare"],
            "locale": "en",
            "timezone": None,
            "refine": None,
            "conversation": [],
            "request": REQUEST,
        }
        # A deep copy crosses, so the expected body below is never the object the bridge forwarded.
        team.chat(
            "team_1",
            copy.deepcopy(payload),
            provider="openai",
            api_key=api_key,
            progress=progress.append,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat")
        self.assertEqual(json.loads(request["body"]), payload)
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

    def test_full_multibyte_message_crosses_the_local_supervisor_boundary(self) -> None:
        identity = local_supervisor.new_identity()
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64
        message = "🧠" * 16_000
        files = [f"{index:032x}" for index in range(1, 9)]
        assistant_ids = []
        for index in range(16):
            prefix = f"a{index}"
            assistant_ids.append(prefix + ("x" * (team_contract.MAX_ASSISTANT_ID_CHARS - len(prefix))))

        with transport.supervisor_session(session, local_identity=identity):
            team.chat(
                "team_1",
                {
                    "message": message,
                    "files": files,
                    "assistant_ids": assistant_ids,
                    "locale": "en",
                    "timezone": None,
                    "refine": None,
                    "conversation": [{"role": "user", "text": "x" * 512, "truncated": False}],
                    "request": REQUEST,
                },
                provider="openai",
                api_key="sk-test-0123456789",
                progress=lambda _event: None,
            )

        request = _ControllerHandler.request
        self.assertGreater(len(request["body"]), 64 * 1024)
        self.assertLessEqual(len(request["body"]), team.MAX_CHAT_JSON_BODY_BYTES)
        self.assertEqual(json.loads(request["body"])["message"], message)
        self.assertIn("x-shimpz-supervisor", request["headers"])

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

    def test_a_browser_phase_may_stay_silent_until_its_task_deadline_and_no_other_phase_may(self) -> None:
        # Team answers with Connection: close and a chunked stream, as in production.
        self.enterContext(mock.patch.object(team, "CHAT_STREAM_TIMEOUT_SECONDS", STREAM_SECONDS))
        for mode, status in (("silent-browser", 200), ("silent-after-browser", 502), ("silent-context", 502)):
            with self.subTest(mode=mode):
                _ControllerHandler.response_mode = mode
                response = team.chat(
                    "team_1",
                    {
                        "message": "Hello",
                        "files": [],
                        "assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                        "refine": None,
                        "conversation": [],
                        "request": REQUEST,
                    },
                    provider="openai",
                    api_key="test-api-key-for-models",
                    progress=lambda _event: None,
                )
                self.assertEqual(response.status, status)

    def test_malformed_or_truncated_stream_fails_closed(self) -> None:
        for mode in ("sequence-gap", "missing-terminal"):
            with self.subTest(mode=mode):
                _ControllerHandler.response_mode = mode
                events: list[dict[str, object]] = []
                response = team.chat(
                    "team_1",
                    {
                        "message": "Hello",
                        "files": [],
                        "assistant_ids": [],
                        "locale": "en",
                        "timezone": None,
                        "refine": None,
                        "conversation": [],
                        "request": REQUEST,
                    },
                    provider="openai",
                    api_key="sk-test-0123456789",
                    progress=events.append,
                )
                self.assertEqual(response, transport.TeamResponse(502, {"detail": "team unavailable"}))
                if mode == "sequence-gap":
                    self.assertEqual(events, [])
