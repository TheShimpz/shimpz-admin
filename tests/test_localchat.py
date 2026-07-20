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
CHALLENGE_ID = "b" * 32


def secret_requirement() -> dict[str, object]:
    return {
        "assistant_id": "shimpz-assistant",
        "assistant_name": "Shimpz Assistant",
        "power_ids": ["identity-me", "create-post"],
        "secrets": [
            {"id": "x-api-key", "name": "X API Key", "summary": "Identifies the X application."},
            {"id": "x-api-secret", "name": "X API Secret", "summary": "Authenticates the X application."},
        ],
    }


def approval_requirements() -> list[dict[str, object]]:
    return [
        {
            "assistant_id": "shimpz-assistant",
            "assistant_name": "Shimpz Assistant",
            "power_id": "create-post",
            "power_summary": "Publish this exact post on X.",
            "input": {"text": "Hello", "reply_to": None},
            "approval": "each-run",
        },
        {
            "assistant_id": "shimpz-assistant",
            "assistant_name": "Shimpz Assistant",
            "power_id": "create-post",
            "power_summary": "Publish this exact post on X.",
            "input": {"text": "Second", "reply_to": "123"},
            "approval": "once",
        },
    ]


def connection_requirement() -> dict[str, object]:
    return {
        "assistant_id": "shimpz-assistant",
        "assistant_name": "Shimpz Assistant",
        "connection_id": "x-account",
        "provider": "x",
        "name": "X account",
        "summary": "Lets approved Powers access the connected X account.",
        "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
        "powers": [
            {"id": "identity-me", "name": "Read profile", "summary": "Read the connected X profile."},
            {"id": "create-post", "name": "Create post", "summary": "Publish a post on X."},
        ],
    }


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

    def test_secret_submission_uses_bounded_json_and_private_model_header(self) -> None:
        model_key = "sk-test-0123456789"
        transport_fixture = "assistant-secret-123456789"
        teams.submit_chat_secrets(
            "team_1",
            {
                "challenge_id": CHALLENGE_ID,
                "values": [
                    {
                        "assistant_id": "shimpz-assistant",
                        "secret_id": "x-api-secret",
                        "value": transport_fixture,
                    }
                ],
            },
            provider="openai",
            api_key=model_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat/secrets")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], model_key)
        self.assertEqual(
            json.loads(request["body"]),
            {
                "challenge_id": CHALLENGE_ID,
                "values": [
                    {
                        "assistant_id": "shimpz-assistant",
                        "secret_id": "x-api-secret",
                        "value": transport_fixture,
                    }
                ],
            },
        )
        self.assertNotIn(model_key.encode(), request["body"])

    def test_approval_submission_uses_private_model_header_and_explicit_boolean(self) -> None:
        model_key = "sk-test-0123456789"
        teams.submit_chat_approval(
            "team_1",
            {"challenge_id": CHALLENGE_ID, "approved": True},
            provider="openai",
            api_key=model_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat/approval")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], model_key)
        self.assertEqual(json.loads(request["body"]), {"challenge_id": CHALLENGE_ID, "approved": True})
        self.assertNotIn(model_key.encode(), request["body"])

    def test_connection_resume_uses_private_model_header_and_exact_challenge(self) -> None:
        model_key = "sk-test-0123456789"
        teams.resume_chat_connections(
            "team_1",
            {"challenge_id": CHALLENGE_ID},
            provider="openai",
            api_key=model_key,
        )

        request = _ControllerHandler.request
        self.assertEqual(request["path"], "/v1/teams/team_1/chat/connections")
        self.assertEqual(request["headers"]["x-shimpz-model-api-key"], model_key)
        self.assertEqual(json.loads(request["body"]), {"challenge_id": CHALLENGE_ID})
        self.assertNotIn(model_key.encode(), request["body"])


class LocalChatOrchestrationTests(unittest.TestCase):
    def test_connection_challenge_projects_only_public_consent_metadata(self) -> None:
        body = {
            "team_id": "team_1",
            "status": "connections-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [connection_requirement()],
            "trace_id": TRACE_ID,
        }

        response = localchat._project_connection_challenge(teams.DriverResponse(428, body), "team_1")

        self.assertEqual(
            response,
            teams.DriverResponse(
                428,
                {key: value for key, value in body.items() if key != "trace_id"},
            ),
        )
        self.assertNotIn("token", json.dumps(response.body).lower())
        self.assertNotIn("client_secret", json.dumps(response.body).lower())

    def test_connection_challenge_fails_closed_on_ambiguous_or_private_data(self) -> None:
        valid = {
            "team_id": "team_1",
            "status": "connections-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [connection_requirement()],
            "trace_id": TRACE_ID,
        }
        requirement = connection_requirement()
        invalid = (
            {**valid, "team_id": "team_2"},
            {**valid, "access_token": "must-not-cross"},
            {**valid, "authorization_code": "must-not-cross"},
            {**valid, "code_verifier": "must-not-cross"},
            {**valid, "expires_in": True},
            {**valid, "expires_in": 0},
            {**valid, "requirements": [requirement, requirement]},
            {**valid, "requirements": [{**requirement, "scopes": ["tweet.read", "tweet.read"]}]},
            {
                **valid,
                "requirements": [
                    {**requirement, "powers": [requirement["powers"][0], requirement["powers"][0]]}
                ],
            },
            {**valid, "requirements": [{**requirement, "client_secret": "must-not-cross"}]},
        )
        for body in invalid:
            with self.subTest(body=body):
                response = localchat._project_connection_challenge(teams.DriverResponse(428, body), "team_1")
            self.assertEqual(
                response,
                teams.DriverResponse(502, {"code": "connection-challenge-response-invalid"}),
            )

    def test_turn_preserves_connection_before_later_gates(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            428,
            {
                "team_id": "team_1",
                "status": "connections-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [connection_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(teams, "chat", return_value=controller),
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Post an update", "files": [], "assistant_ids": ["shimpz-assistant"]},
            )

        self.assertEqual(response.status, 428)
        self.assertEqual(response.body["status"], "connections-required")
        self.assertEqual(response.body["requirements"], [connection_requirement()])

    def test_pending_connection_is_team_bound_and_none_is_closed(self) -> None:
        pending = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "status": "connections-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [connection_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(teams, "pending_chat_connections", return_value=pending):
            projected = localchat.pending_connections("team_1")
        self.assertEqual(projected.body["status"], "connections-required")
        self.assertNotIn("trace_id", projected.body)

        none = teams.DriverResponse(200, {"team_id": "team_1", "status": "none", "trace_id": TRACE_ID})
        with mock.patch.object(teams, "pending_chat_connections", return_value=none):
            self.assertEqual(
                localchat.pending_connections("team_1"),
                teams.DriverResponse(200, {"team_id": "team_1", "status": "none"}),
            )

        cross_team = teams.DriverResponse(200, {**none.body, "team_id": "team_2"})
        with mock.patch.object(teams, "pending_chat_connections", return_value=cross_team):
            self.assertEqual(
                localchat.pending_connections("team_1"),
                teams.DriverResponse(502, {"code": "connection-challenge-response-invalid"}),
            )

    def test_connection_resume_can_advance_to_secret_gate_or_done(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        secret_gate = teams.DriverResponse(
            428,
            {
                "team_id": "team_1",
                "status": "secrets-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "requirements": [secret_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        done = teams.DriverResponse(
            200,
            {"team_id": "team_1", "team_name": "Marketing", "reply": "Posted", "trace_id": TRACE_ID},
        )
        for controller, expected_status in ((secret_gate, "secrets-required"), (done, None)):
            with (
                self.subTest(controller=controller),
                mock.patch.object(teams, "get_inference", return_value=inference),
                mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(teams, "resume_chat_connections", return_value=controller) as resume,
            ):
                response = localchat.resume_connections("team_1", CHALLENGE_ID)
            resume.assert_called_once_with(
                "team_1",
                {"challenge_id": CHALLENGE_ID},
                provider="openai",
                api_key="sk-test-0123456789",
            )
            if expected_status is None:
                self.assertEqual(response.body["reply"], "Posted")
            else:
                self.assertEqual(response.body["status"], expected_status)

    def test_connection_resume_rejects_augmented_or_invalid_payload_before_transport(self) -> None:
        invalid = (
            {},
            {"challenge_id": "short"},
            {"challenge_id": CHALLENGE_ID, "authorization_code": "must-not-cross"},
            {"challenge_id": CHALLENGE_ID, "access_token": "must-not-cross"},
        )
        with mock.patch.object(teams, "_call") as transport:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    teams.resume_chat_connections(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
                    )
        transport.assert_not_called()

    def test_secret_replacement_is_exact_and_projects_only_masks(self) -> None:
        payload = {
            "assistant_id": "shimpz-assistant",
            "values": [{"secret_id": "x-api-key", "value": "replacement-secret-123"}],
        }
        controller = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "assistants": [
                    {
                        "id": "shimpz-assistant",
                        "name": "Shimpz Assistant",
                        "secrets": [
                            {
                                "id": "x-api-key",
                                "name": "X API Key",
                                "summary": "Identifies the application.",
                                "configured": True,
                                "mask": "repl…t123",
                            }
                        ],
                    }
                ],
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(teams, "replace_assistant_secrets", return_value=controller) as replace:
            response = localchat.replace_secrets("team_1", payload)

        replace.assert_called_once_with("team_1", payload)
        self.assertEqual(response.status, 200)
        self.assertNotIn(payload["values"][0]["value"], json.dumps(response.body))
        self.assertEqual(response.body["assistants"][0]["secrets"][0]["mask"], "repl…t123")

    def test_secret_replacement_rejects_ambiguous_batches_before_transport(self) -> None:
        valid = {
            "assistant_id": "shimpz-assistant",
            "values": [{"secret_id": "x-api-key", "value": "replacement-secret-123"}],
        }
        invalid = (
            {**valid, "extra": True},
            {**valid, "values": []},
            {**valid, "values": [valid["values"][0], valid["values"][0]]},
            {**valid, "values": [{"secret_id": "x-api-key", "value": " line\nbreak"}]},
            {**valid, "values": [{**valid["values"][0], "assistant_id": "other"}]},
        )
        with mock.patch.object(teams, "replace_assistant_secrets") as replace:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    localchat.replace_secrets("team_1", payload)
        replace.assert_not_called()

    def test_secret_submission_contract_rejects_ambiguity_before_transport(self) -> None:
        valid = {
            "challenge_id": CHALLENGE_ID,
            "values": [
                {
                    "assistant_id": "shimpz-assistant",
                    "secret_id": "x-api-key",
                    "value": "secret-value-123",
                }
            ],
        }
        invalid = (
            {**valid, "extra": True},
            {"challenge_id": "short", "values": valid["values"]},
            {"challenge_id": CHALLENGE_ID, "values": []},
            {
                "challenge_id": CHALLENGE_ID,
                "values": [valid["values"][0], valid["values"][0]],
            },
            {
                "challenge_id": CHALLENGE_ID,
                "values": [{**valid["values"][0], "value": " line\nbreak"}],
            },
        )
        with mock.patch.object(teams, "_call") as transport:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    teams.submit_chat_secrets(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
                    )
        transport.assert_not_called()

    def test_missing_secrets_are_projected_as_one_closed_batch(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            428,
            {
                "team_id": "team_1",
                "status": "secrets-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "requirements": [secret_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(teams, "chat", return_value=controller),
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Post an update", "files": [], "assistant_ids": ["shimpz-assistant"]},
            )

        self.assertEqual(response.status, 428)
        self.assertEqual(
            response.body,
            {
                "team_id": "team_1",
                "status": "secrets-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "requirements": [secret_requirement()],
            },
        )
        self.assertNotIn("value", json.dumps(response.body))

    def test_power_approvals_project_exact_inputs_and_public_policies(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            428,
            {
                "team_id": "team_1",
                "status": "approval-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "requirements": approval_requirements(),
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(teams, "chat", return_value=controller),
        ):
            response = localchat.turn(
                "team_1",
                {"message": "Post both", "files": [], "assistant_ids": ["shimpz-assistant"]},
            )

        expected = approval_requirements()
        expected[0]["approval"] = "always"
        self.assertEqual(response.status, 428)
        self.assertEqual(response.body["requirements"], expected)
        self.assertEqual(response.body["requirements"][0]["input"], {"text": "Hello", "reply_to": None})
        self.assertEqual(response.body["requirements"][1]["power_id"], "create-post")
        self.assertNotIn("trace_id", response.body)
        self.assertNotIn("api_key", json.dumps(response.body))
        self.assertNotIn("secret_values", json.dumps(response.body))

    def test_power_approval_contract_fails_closed_on_ambiguous_or_unbounded_data(self) -> None:
        valid = {
            "team_id": "team_1",
            "status": "approval-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "requirements": approval_requirements(),
            "trace_id": TRACE_ID,
        }
        invalid = (
            {**valid, "team_id": "other-team"},
            {**valid, "api_key": "must-not-cross"},
            {**valid, "requirements": [{**approval_requirements()[0], "approval": "always"}]},
            {
                **valid,
                "requirements": [{**approval_requirements()[0], "input": {"text": "x" * (32 * 1024 + 1)}}],
            },
            {
                **valid,
                "requirements": [{**approval_requirements()[0], "input": {"temperature": float("nan")}}],
            },
        )
        for body in invalid:
            with self.subTest(body=body):
                response = localchat._project_approval_challenge(teams.DriverResponse(428, body), "team_1")
            self.assertEqual(response, teams.DriverResponse(502, {"code": "approval-challenge-response-invalid"}))

    def test_approval_submission_requires_true_and_exact_shape_before_transport(self) -> None:
        valid = {"challenge_id": CHALLENGE_ID, "approved": True}
        invalid = (
            {**valid, "approved": False},
            {**valid, "extra": True},
            {"challenge_id": "short", "approved": True},
            {"challenge_id": CHALLENGE_ID, "approved": 1},
        )
        with mock.patch.object(teams, "_call") as transport:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    teams.submit_chat_approval(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
                    )
        transport.assert_not_called()

    def test_secret_challenge_and_inventory_fail_closed_on_extra_or_cross_team_data(self) -> None:
        valid_challenge = {
            "team_id": "team_1",
            "status": "secrets-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "requirements": [secret_requirement()],
            "trace_id": TRACE_ID,
        }
        invalid_challenges = (
            {**valid_challenge, "team_id": "team_2"},
            {**valid_challenge, "secret": "must-not-cross"},
            {**valid_challenge, "requirements": [secret_requirement(), secret_requirement()]},
            {
                **valid_challenge,
                "requirements": [
                    {
                        **secret_requirement(),
                        "secrets": [{"id": "x-api-key", "name": "X", "summary": "x", "value": "leak"}],
                    }
                ],
            },
        )
        for body in invalid_challenges:
            with self.subTest(body=body):
                response = localchat._project_challenge(teams.DriverResponse(428, body), "team_1")
            self.assertEqual(response, teams.DriverResponse(502, {"code": "secret-challenge-response-invalid"}))

        valid_inventory = {
            "team_id": "team_1",
            "assistants": [
                {
                    "id": "shimpz-assistant",
                    "name": "Shimpz Assistant",
                    "secrets": [
                        {
                            "id": "x-api-key",
                            "name": "X API Key",
                            "summary": "Identifies the application.",
                            "configured": True,
                            "mask": "abcd…wxyz",
                        }
                    ],
                }
            ],
            "trace_id": TRACE_ID,
        }
        projected = localchat._project_inventory(teams.DriverResponse(200, valid_inventory), "team_1")
        self.assertEqual(projected.status, 200)
        self.assertNotIn("value", json.dumps(projected.body))
        for invalid in (
            {**valid_inventory, "team_id": "team_2"},
            {**valid_inventory, "assistants": [{**valid_inventory["assistants"][0], "value": "leak"}]},
            {
                **valid_inventory,
                "assistants": [
                    {
                        **valid_inventory["assistants"][0],
                        "secrets": [
                            {
                                **valid_inventory["assistants"][0]["secrets"][0],
                                "mask": "too-much-visible",
                            }
                        ],
                    }
                ],
            },
        ):
            with self.subTest(invalid=invalid):
                response = localchat._project_inventory(teams.DriverResponse(200, invalid), "team_1")
            self.assertEqual(response, teams.DriverResponse(502, {"code": "secret-inventory-response-invalid"}))

    def test_submitted_secret_cannot_be_reflected_by_the_controller(self) -> None:
        leak_fixture = "assistant-secret-123456789"
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": f"unsafe {leak_fixture}",
                "trace_id": TRACE_ID,
            },
        )
        payload = {
            "challenge_id": CHALLENGE_ID,
            "values": [
                {
                    "assistant_id": "shimpz-assistant",
                    "secret_id": "x-api-key",
                    "value": leak_fixture,
                }
            ],
        }
        with (
            mock.patch.object(teams, "get_inference", return_value=inference),
            mock.patch.object(modelproviders, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(teams, "submit_chat_secrets", return_value=controller),
        ):
            response = localchat.submit_secrets("team_1", payload)

        self.assertEqual(response, teams.DriverResponse(502, {"code": "chat-response-invalid"}))
        self.assertNotIn(leak_fixture, json.dumps(response.body))

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

    def test_remembered_approval_inventory_and_revoke_are_closed_public_documents(self) -> None:
        inventory = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "grants": [
                    {"assistant_id": "shimpz-assistant", "power_id": "create-post"},
                    {"assistant_id": "shimpz-assistant", "power_id": "delete-post"},
                ],
                "trace_id": TRACE_ID,
            },
        )
        revoked = teams.DriverResponse(
            200,
            {"team_id": "team_1", "revoked": 2, "trace_id": TRACE_ID},
        )
        with (
            mock.patch.object(teams, "list_assistant_approvals", return_value=inventory),
            mock.patch.object(teams, "revoke_assistant_approvals", return_value=revoked),
        ):
            projected = localchat.approval_inventory("team_1")
            cleared = localchat.revoke_approvals("team_1")

        self.assertEqual(projected.body, {"team_id": "team_1", "grants": inventory.body["grants"]})
        self.assertEqual(cleared.body, {"team_id": "team_1", "revoked": 2})
        self.assertNotIn("trace_id", projected.body)

        duplicate = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "grants": [inventory.body["grants"][0], inventory.body["grants"][0]],
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(teams, "list_assistant_approvals", return_value=duplicate):
            self.assertEqual(
                localchat.approval_inventory("team_1"),
                teams.DriverResponse(502, {"code": "approval-inventory-response-invalid"}),
            )

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
