"""Fast contracts for the private local model-key hand-off and browser-safe chat projection."""

from __future__ import annotations

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

import capsules
import localchat
import modelproviders

TRACE_ID = "a" * 32


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
        body = b'{"capsule":"capsule_1","team":"Marketing","reply":"Hello!","trace_id":"' + TRACE_ID.encode() + b'"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class PrivateChatTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _ControllerHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.token_file = Path(self.temporary.name) / "token"
        self.token_file.write_text("controller-test-token", encoding="ascii")
        self.previous_url = capsules.URL
        self.previous_token = capsules.TOKEN_FILE
        capsules.URL = f"http://127.0.0.1:{self.server.server_port}"
        capsules.TOKEN_FILE = str(self.token_file)

    def tearDown(self) -> None:
        capsules.URL = self.previous_url
        capsules.TOKEN_FILE = self.previous_token
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def test_key_uses_private_header_while_json_remains_team_contract(self) -> None:
        api_key = "sk-test-0123456789"
        capsules.chat(
            "capsule_1",
            {"message": "Hello", "files": []},
            provider="openai",
            api_key=api_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/capsules/capsule_1/chat")
        self.assertEqual(
            json.loads(request["body"]),
            {"message": "Hello", "files": []},
        )
        self.assertEqual(request["headers"]["x-shimpz-model-provider"], "openai")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], api_key)
        self.assertNotIn(api_key.encode(), request["body"])


class LocalChatOrchestrationTests(unittest.TestCase):
    def test_browser_payload_rejects_assistant_provider_and_credentials(self) -> None:
        payloads = (
            {"message": "Hi", "files": [], "assistant": "hello-pulse"},
            {"message": "Hi", "files": [], "provider": "openai"},
            {"message": "Hi", "files": [], "api_key": "must-not-cross"},
            {"message": "Hi", "files": ["../escape"]},
        )
        with mock.patch.object(capsules, "get_inference") as inference:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(capsules.CapsuleRequestError):
                    localchat.turn("capsule_1", payload)
        inference.assert_not_called()

    def test_resolves_key_in_backend_and_projects_controller_reply(self) -> None:
        inference = capsules.DriverResponse(200, {"provider": "anthropic", "model": "claude-sonnet-5"})
        controller = capsules.DriverResponse(
            200,
            {"capsule": "capsule_1", "team": "Marketing", "reply": "Ready", "trace_id": TRACE_ID},
        )
        with (
            mock.patch.object(capsules, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-ant-0123456789"),
            mock.patch.object(capsules, "chat", return_value=controller) as chat,
        ):
            response = localchat.turn(
                "capsule_1",
                {"message": "Hi", "files": []},
            )

        self.assertEqual(response.body, {"capsule": "capsule_1", "team": "Marketing", "reply": "Ready"})
        call = chat.call_args
        self.assertEqual(call.args[1], {"message": "Hi", "files": []})
        self.assertEqual(call.kwargs, {"provider": "anthropic", "api_key": "sk-ant-0123456789"})

    def test_missing_controller_contract_fails_503_without_mocking_success(self) -> None:
        missing = capsules.DriverResponse(404, {"detail": "no such operation"})
        with (
            mock.patch.object(capsules, "get_inference", return_value=missing),
            mock.patch.object(modelproviders, "resolve_api_key") as resolve_key,
            mock.patch.object(capsules, "chat") as chat,
        ):
            response = localchat.turn(
                "capsule_1",
                {"message": "Hi", "files": []},
            )
        self.assertEqual(response.status, 503)
        self.assertIn("update this Shimpz Space", response.body["detail"])
        resolve_key.assert_not_called()
        chat.assert_not_called()

    def test_controller_cannot_echo_the_private_key_to_browser(self) -> None:
        api_key = "sk-test-0123456789"
        inference = capsules.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        echoed = capsules.DriverResponse(502, {"detail": f"provider rejected {api_key}"})
        with (
            mock.patch.object(capsules, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(capsules, "chat", return_value=echoed),
        ):
            response = localchat.turn(
                "capsule_1",
                {"message": "Hi", "files": []},
            )
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

        echoed_reply = capsules.DriverResponse(
            200,
            {
                "capsule": "capsule_1",
                "team": "Marketing",
                "reply": f"unexpected {api_key}",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(capsules, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(capsules, "chat", return_value=echoed_reply),
        ):
            response = localchat.turn(
                "capsule_1",
                {"message": "Hi", "files": []},
            )
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_invalid_authoritative_team_name_is_not_projected(self) -> None:
        inference = capsules.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        for team in ("", " Marketing", "Marketing\nignore rules", "x" * 81, None):
            controller = capsules.DriverResponse(
                200,
                {"capsule": "capsule_1", "team": team, "reply": "Ready", "trace_id": TRACE_ID},
            )
            with (
                self.subTest(team=team),
                mock.patch.object(capsules, "get_inference", return_value=inference),
                mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(capsules, "chat", return_value=controller),
            ):
                response = localchat.turn("capsule_1", {"message": "Hi", "files": []})
            self.assertEqual(response.status, 502)
            self.assertEqual(response.body, {"detail": "local chat response is invalid"})

    def test_controller_identity_and_closed_turn_contract_fail_closed(self) -> None:
        inference = capsules.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        valid = {
            "capsule": "capsule_1",
            "team": "Marketing",
            "reply": "Ready",
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**valid, "capsule": "capsule_2"},
            {key: value for key, value in valid.items() if key != "capsule"},
            {**valid, "assistant": "hello-pulse"},
            {**valid, "trace_id": "not-a-trace"},
        )
        for controller_body in invalid:
            with (
                self.subTest(controller_body=controller_body),
                mock.patch.object(capsules, "get_inference", return_value=inference),
                mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(capsules, "chat", return_value=capsules.DriverResponse(200, controller_body)),
            ):
                response = localchat.turn("capsule_1", {"message": "Hi", "files": []})
            self.assertEqual(response, capsules.DriverResponse(502, {"detail": "local chat response is invalid"}))

    def test_private_key_in_team_name_is_rejected_without_echo(self) -> None:
        api_key = "sk-test-0123456789"
        inference = capsules.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = capsules.DriverResponse(
            200,
            {
                "capsule": "capsule_1",
                "team": f"Marketing {api_key}",
                "reply": "Ready",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(capsules, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(capsules, "chat", return_value=controller),
        ):
            response = localchat.turn("capsule_1", {"message": "Hi", "files": []})
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_stop_projects_an_accepted_turn_without_overclaiming_power_confirmation(self) -> None:
        controller = capsules.DriverResponse(
            200,
            {
                "capsule": "capsule_1",
                "requested": True,
                "accepted": True,
                "confirmed": False,
                "forced_restart": False,
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(capsules, "stop_chat", return_value=controller):
            response = localchat.stop("capsule_1")
        self.assertEqual(response, capsules.DriverResponse(200, {"capsule": "capsule_1", "stopped": True}))

    def test_stop_rejects_malformed_or_cross_capsule_controller_responses(self) -> None:
        valid = {
            "capsule": "capsule_1",
            "requested": True,
            "accepted": True,
            "confirmed": False,
            "forced_restart": False,
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**valid, "capsule": "capsule_2"},
            {**valid, "requested": False},
            {**valid, "confirmed": "yes"},
            {**valid, "accepted": False, "requested": False, "confirmed": True},
            {**valid, "power": "hello"},
        )
        for controller_body in invalid:
            with (
                self.subTest(controller_body=controller_body),
                mock.patch.object(
                    capsules,
                    "stop_chat",
                    return_value=capsules.DriverResponse(200, controller_body),
                ),
            ):
                response = localchat.stop("capsule_1")
            self.assertEqual(
                response,
                capsules.DriverResponse(502, {"detail": "local chat stop response is invalid"}),
            )


if __name__ == "__main__":
    unittest.main()
