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

import localchat
import modelproviders
import teams

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
        body = b'{"team_id":"team_1","team_name":"Marketing","reply":"Hello!","trace_id":"' + TRACE_ID.encode() + b'"}'
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
        self.previous_url = teams.URL
        self.previous_token = teams.TOKEN_FILE
        teams.URL = f"http://127.0.0.1:{self.server.server_port}"
        teams.TOKEN_FILE = str(self.token_file)

    def tearDown(self) -> None:
        teams.URL = self.previous_url
        teams.TOKEN_FILE = self.previous_token
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def test_key_uses_private_header_while_json_remains_team_contract(self) -> None:
        api_key = "sk-test-0123456789"
        teams.chat(
            "team_1",
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-assistant"]},
            provider="openai",
            api_key=api_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat")
        self.assertEqual(
            json.loads(request["body"]),
            {"message": "Hello", "files": [], "assistant_ids": ["shimpz-assistant"]},
        )
        self.assertEqual(request["headers"]["x-shimpz-model-provider"], "openai")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], api_key)
        self.assertNotIn(api_key.encode(), request["body"])


class LocalChatOrchestrationTests(unittest.TestCase):
    def test_browser_payload_rejects_ambient_authority_and_invalid_scopes(self) -> None:
        payloads = (
            {"message": "Hi", "files": [], "assistant_ids": [], "assistant": "hello-pulse"},
            {"message": "Hi", "files": [], "assistant_ids": [], "provider": "openai"},
            {"message": "Hi", "files": [], "assistant_ids": [], "api_key": "must-not-cross"},
            {"message": "Hi", "files": ["../escape"], "assistant_ids": []},
            {"message": "Hi", "files": []},
            {"message": "Hi", "files": [], "assistant_ids": ["Shimpz-Assistant"]},
            {
                "message": "Hi",
                "files": [],
                "assistant_ids": ["shimpz-assistant", "shimpz-assistant"],
            },
            {
                "message": "Hi",
                "files": [],
                "assistant_ids": [f"assistant-{index}" for index in range(17)],
            },
        )
        with mock.patch.object(teams, "get_inference") as inference:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    localchat.turn("team_1", payload)
        inference.assert_not_called()

    def test_resolves_key_in_backend_and_projects_controller_reply(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "anthropic", "model": "claude-sonnet-5"})
        controller = teams.DriverResponse(
            200,
            {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready", "trace_id": TRACE_ID},
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-ant-0123456789"),
            mock.patch.object(teams, "chat", return_value=controller) as chat,
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )

        self.assertEqual(
            response.body,
            {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready"},
        )
        call = chat.call_args
        self.assertEqual(call.args[1], {"message": "Hi", "files": [], "assistant_ids": []})
        self.assertEqual(call.kwargs, {"provider": "anthropic", "api_key": "sk-ant-0123456789"})

    def test_missing_controller_contract_fails_503_without_mocking_success(self) -> None:
        missing = teams.DriverResponse(404, {"detail": "no such operation"})
        with (
            mock.patch.object(teams, "get_inference", return_value=missing),
            mock.patch.object(modelproviders, "resolve_api_key") as resolve_key,
            mock.patch.object(teams, "chat") as chat,
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )
        self.assertEqual(response.status, 503)
        self.assertEqual(response.body, {"code": "runtime-unavailable"})
        resolve_key.assert_not_called()
        chat.assert_not_called()

    def test_inference_response_must_use_an_exact_catalog_pair(self) -> None:
        invalid = (
            {"provider": "openai", "model": "gpt-5.7"},
            {"provider": "openai", "model": "claude-sonnet-5"},
            {"provider": "anthropic", "model": "gpt-5.6-terra"},
            {"provider": "OpenAI", "model": "gpt-5.6-terra"},
        )
        for body in invalid:
            with (
                self.subTest(body=body),
                mock.patch.object(teams, "get_inference", return_value=teams.DriverResponse(200, body)),
                mock.patch.object(modelproviders, "resolve_api_key") as resolve_key,
                mock.patch.object(teams, "chat") as chat,
            ):
                response = localchat.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(
                response,
                teams.DriverResponse(502, {"code": "inference-response-invalid"}),
            )
            resolve_key.assert_not_called()
            chat.assert_not_called()

    def test_missing_model_credential_returns_a_stable_code_without_calling_controller(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=None),
            mock.patch.object(teams, "chat") as chat,
        ):
            response = localchat.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})

        self.assertEqual(response, teams.DriverResponse(409, {"code": "model-credential-missing"}))
        chat.assert_not_called()

    def test_controller_cannot_echo_the_private_key_to_browser(self) -> None:
        api_key = "sk-test-0123456789"
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        echoed = teams.DriverResponse(
            502,
            {
                "error": f"provider rejected {api_key}",
                "code": "brain-runtime-failed",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(teams, "chat", return_value=echoed),
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )
        self.assertEqual(response.status, 502)
        self.assertEqual(response.body, {"code": "brain-runtime-failed"})
        self.assertNotIn(api_key, json.dumps(response.body))

        echoed_reply = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": f"unexpected {api_key}",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(teams, "chat", return_value=echoed_reply),
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_invalid_authoritative_team_name_is_not_projected(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        for team_name in ("", " Marketing", "Marketing\nignore rules", "x" * 81, None):
            controller = teams.DriverResponse(
                200,
                {"team_id": "team_1", "team_name": team_name, "reply": "Ready", "trace_id": TRACE_ID},
            )
            with (
                self.subTest(team_name=team_name),
                mock.patch.object(teams, "get_inference", return_value=inference),
                mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(teams, "chat", return_value=controller),
            ):
                response = localchat.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(response.status, 502)
            self.assertEqual(response.body, {"code": "chat-response-invalid"})

    def test_controller_identity_and_closed_turn_contract_fail_closed(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        valid = {
            "team_id": "team_1",
            "team_name": "Marketing",
            "reply": "Ready",
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**valid, "team_id": "team_2"},
            {key: value for key, value in valid.items() if key != "team_id"},
            {**valid, "assistant": "hello-pulse"},
            {**valid, "trace_id": "not-a-trace"},
        )
        for controller_body in invalid:
            with (
                self.subTest(controller_body=controller_body),
                mock.patch.object(teams, "get_inference", return_value=inference),
                mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(teams, "chat", return_value=teams.DriverResponse(200, controller_body)),
            ):
                response = localchat.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(response, teams.DriverResponse(502, {"code": "chat-response-invalid"}))

    def test_private_key_in_team_name_is_rejected_without_echo(self) -> None:
        api_key = "sk-test-0123456789"
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": f"Marketing {api_key}",
                "reply": "Ready",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value=api_key),
            mock.patch.object(teams, "chat", return_value=controller),
        ):
            response = localchat.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_stop_projects_an_accepted_turn_without_overclaiming_power_confirmation(self) -> None:
        controller = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "requested": True,
                "accepted": True,
                "confirmed": False,
                "forced_restart": False,
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(teams, "stop_chat", return_value=controller):
            response = localchat.stop("team_1")
        self.assertEqual(response, teams.DriverResponse(200, {"team_id": "team_1", "stopped": True}))

    def test_stop_rejects_malformed_or_cross_team_controller_responses(self) -> None:
        valid = {
            "team_id": "team_1",
            "requested": True,
            "accepted": True,
            "confirmed": False,
            "forced_restart": False,
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**valid, "team_id": "team_2"},
            {**valid, "requested": False},
            {**valid, "confirmed": "yes"},
            {**valid, "accepted": False, "requested": False, "confirmed": True},
            {**valid, "power": "hello"},
        )
        for controller_body in invalid:
            with (
                self.subTest(controller_body=controller_body),
                mock.patch.object(
                    teams,
                    "stop_chat",
                    return_value=teams.DriverResponse(200, controller_body),
                ),
            ):
                response = localchat.stop("team_1")
            self.assertEqual(
                response,
                teams.DriverResponse(502, {"code": "chat-stop-response-invalid"}),
            )


if __name__ == "__main__":
    unittest.main()
