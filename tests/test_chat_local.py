"""Fast contracts for the private local model-key hand-off and browser-safe chat projection."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import models
from team import bridge as team

from chat import local

TRACE_ID = "a" * 32
CHALLENGE_ID = "b" * 32


def secret_requirement() -> dict[str, object]:
    return {
        "assistant_id": "shimpz-cloudflare",
        "assistant_name": "Shimpz Cloudflare",
        "power_ids": ["identity-me", "create-post"],
        "secrets": [
            {"id": "x-api-key", "name": "X API Key", "summary": "Identifies the X application."},
            {"id": "x-api-secret", "name": "X API Secret", "summary": "Authenticates the X application."},
        ],
    }


def approval_requirements() -> list[dict[str, object]]:
    return [
        {
            "assistant_id": "shimpz-cloudflare",
            "assistant_name": "Shimpz Cloudflare",
            "power_id": "create-post",
            "title": "Publish post",
            "summary": "Publish this exact post on X.",
            "docs": "https://docs.example.com/publish",
            "approval": "once",
        },
    ]


def integration_requirement() -> dict[str, object]:
    return {
        "assistant_id": "shimpz-cloudflare",
        "assistant_name": "Shimpz Cloudflare",
        "integration_id": "x-integration",
        "provider": "x",
        "name": "X integration",
        "summary": "Lets approved Powers access the connected X integration.",
        "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
        "powers": [
            {"id": "identity-me", "name": "Read profile", "summary": "Read the connected X profile."},
            {"id": "create-post", "name": "Create post", "summary": "Publish a post on X."},
        ],
    }


def input_request(request_type: str, options: list[str] | None = None) -> dict[str, object]:
    return {
        "type": request_type,
        "title": "Choose",
        "summary": "Provide one value.",
        "docs": "https://docs.example.com",
        "options": options or [],
    }


class LocalChatOrchestrationTests(unittest.TestCase):
    def test_integration_challenge_projects_only_public_consent_metadata(self) -> None:
        body = {
            "team_id": "team_1",
            "status": "integrations-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [integration_requirement()],
            "trace_id": TRACE_ID,
        }

        response = local._project_integration_challenge(team.TeamResponse(428, body), "team_1")

        self.assertEqual(
            response,
            team.TeamResponse(
                428,
                {key: value for key, value in body.items() if key != "trace_id"},
            ),
        )
        self.assertNotIn("token", json.dumps(response.body).lower())
        self.assertNotIn("client_secret", json.dumps(response.body).lower())

    def test_integration_challenge_fails_closed_on_ambiguous_or_private_data(self) -> None:
        valid = {
            "team_id": "team_1",
            "status": "integrations-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [integration_requirement()],
            "trace_id": TRACE_ID,
        }
        requirement = integration_requirement()
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
                "requirements": [{**requirement, "powers": [requirement["powers"][0], requirement["powers"][0]]}],
            },
            {**valid, "requirements": [{**requirement, "client_secret": "must-not-cross"}]},
        )
        for body in invalid:
            with self.subTest(body=body):
                response = local._project_integration_challenge(team.TeamResponse(428, body), "team_1")
            self.assertEqual(
                response,
                team.TeamResponse(502, {"code": "integration-challenge-response-invalid"}),
            )

    def test_turn_preserves_integration_before_later_gates(self) -> None:
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = team.TeamResponse(
            428,
            {
                "team_id": "team_1",
                "status": "integrations-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [integration_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(team, "chat", return_value=controller),
        ):
            response = local.turn(
                "team_1",
                {"message": "Post an update", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
            )

        self.assertEqual(response.status, 428)
        self.assertEqual(response.body["status"], "integrations-required")
        self.assertEqual(response.body["requirements"], [integration_requirement()])

    def test_turn_reports_measured_admin_and_team_execution_events(self) -> None:
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": "Ready.",
                "trace_id": TRACE_ID,
            },
        )
        events: list[dict[str, object]] = []

        def execute_chat(*_args, progress, **_kwargs):
            progress({"seq": 1, "phase": "model", "state": "started"})
            progress(
                {
                    "seq": 2,
                    "phase": "model",
                    "state": "finished",
                    "elapsed_ms": 18,
                }
            )
            progress(
                {
                    "seq": 3,
                    "phase": "power",
                    "state": "started",
                    "assistant_id": "shimpz-cloudflare",
                    "power": "list-zones",
                    "index": 1,
                    "total": 1,
                }
            )
            progress(
                {
                    "seq": 4,
                    "phase": "power",
                    "state": "finished",
                    "elapsed_ms": 6,
                    "assistant_id": "shimpz-cloudflare",
                    "power": "list-zones",
                    "index": 1,
                    "total": 1,
                }
            )
            return controller

        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789"),
            mock.patch.object(team, "chat", side_effect=execute_chat),
        ):
            response = local.turn(
                "team_1",
                {"message": "Hello", "files": [], "assistant_ids": []},
                events.append,
            )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            [(event["origin"], event["phase"], event["state"]) for event in events],
            [
                ("admin", "admin-preparation", "started"),
                ("admin", "admin-preparation", "finished"),
                ("team", "model", "started"),
                ("team", "model", "finished"),
                ("team", "power", "started"),
                ("team", "power", "finished"),
                ("admin", "reply-validation", "started"),
                ("admin", "reply-validation", "finished"),
            ],
        )
        power_events = [event for event in events if event["phase"] == "power"]
        self.assertTrue(
            all(
                (event["assistant_id"], event["power"]) == ("shimpz-cloudflare", "list-zones") for event in power_events
            )
        )
        self.assertIsInstance(events[-1]["elapsed_ms"], int)

    def test_pending_integration_is_team_bound_and_none_is_closed(self) -> None:
        pending = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "status": "integrations-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [integration_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(team, "pending_chat_integrations", return_value=pending):
            projected = local.pending_integrations("team_1")
        self.assertEqual(projected.body["status"], "integrations-required")
        self.assertNotIn("trace_id", projected.body)

        none = team.TeamResponse(200, {"team_id": "team_1", "status": "none", "trace_id": TRACE_ID})
        with mock.patch.object(team, "pending_chat_integrations", return_value=none):
            self.assertEqual(
                local.pending_integrations("team_1"),
                team.TeamResponse(200, {"team_id": "team_1", "status": "none"}),
            )

        cross_team = team.TeamResponse(200, {**none.body, "team_id": "team_2"})
        with mock.patch.object(team, "pending_chat_integrations", return_value=cross_team):
            self.assertEqual(
                local.pending_integrations("team_1"),
                team.TeamResponse(502, {"code": "integration-challenge-response-invalid"}),
            )

    def test_integration_resume_rejects_augmented_or_invalid_payload_before_transport(self) -> None:
        invalid = (
            {},
            {"challenge_id": "short"},
            {"challenge_id": CHALLENGE_ID, "authorization_code": "must-not-cross"},
            {"challenge_id": CHALLENGE_ID, "access_token": "must-not-cross"},
        )
        with mock.patch.object(team, "_call") as transport:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(team.TeamRequestError):
                    team.resume_chat_integrations(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
                        progress=lambda _event: None,
                    )
        transport.assert_not_called()

    def test_human_resume_binds_only_exact_successful_assurance(self) -> None:
        response = team.TeamResponse(200, {})
        assurance = {"kind": "auth:reauth", "challenge_id": CHALLENGE_ID}
        with mock.patch.object(team, "_call_stream", return_value=response) as transport:
            result = team.resume_chat_human(
                "team_1",
                {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": True},
                provider="openai",
                api_key="sk-test-0123456789",
                progress=lambda _event: None,
                assurance=assurance,
            )

        self.assertEqual(result, response)
        bindings = transport.call_args.kwargs["bindings"]
        self.assertEqual(bindings.human_assurance, assurance)
        self.assertEqual(bindings.model_credential, ("openai", "sk-test-0123456789"))
        self.assertEqual(transport.call_args.args[1], "/v1/teams/team_1/chat/human")

        invalid = (
            ({"challenge_id": CHALLENGE_ID, "decision": "deny"}, assurance),
            (
                {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": True},
                {**assurance, "challenge_id": "c" * 32},
            ),
            (
                {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": "password"},
                assurance,
            ),
            (
                {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": True},
                {"kind": "auth:unknown", "challenge_id": CHALLENGE_ID},
            ),
        )
        with mock.patch.object(team, "_call_stream") as transport:
            for payload, evidence in invalid:
                with self.subTest(payload=payload, evidence=evidence), self.assertRaises(
                    team.TeamRequestError
                ):
                    team.resume_chat_human(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
                        progress=lambda _event: None,
                        assurance=evidence,
                    )
        transport.assert_not_called()

    def test_human_resume_accepts_only_bounded_browser_values(self) -> None:
        valid_values = (True, "", "notes\nwith detail", ["one", "two"])
        with mock.patch.object(team, "_call_stream", return_value=team.TeamResponse(200, {})) as transport:
            for value in valid_values:
                with self.subTest(value=value):
                    team.resume_chat_human(
                        "team_1",
                        {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": value},
                        provider="openai",
                        api_key="sk-test-0123456789",
                        progress=lambda _event: None,
                    )
        self.assertEqual(transport.call_count, len(valid_values))

        invalid_values = (False, None, 1, {}, ["duplicate", "duplicate"], "x" * 16_001)
        with mock.patch.object(team, "_call_stream") as transport:
            for value in invalid_values:
                with self.subTest(value=value), self.assertRaises(team.TeamRequestError):
                    team.resume_chat_human(
                        "team_1",
                        {"challenge_id": CHALLENGE_ID, "decision": "submit", "value": value},
                        provider="openai",
                        api_key="sk-test-0123456789",
                        progress=lambda _event: None,
                    )
        transport.assert_not_called()

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
                "assistant_ids": ["shimpz-cloudflare", "shimpz-cloudflare"],
            },
            {
                "message": "Hi",
                "files": [],
                "assistant_ids": [f"assistant-{index}" for index in range(17)],
            },
        )
        with mock.patch.object(team, "get_inference") as inference:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(team.TeamRequestError):
                    local.turn("team_1", payload)
        inference.assert_not_called()

    def test_resolves_key_in_backend_and_projects_controller_reply(self) -> None:
        inference = team.TeamResponse(200, {"provider": "anthropic", "model": "claude-sonnet-5"})
        controller = team.TeamResponse(
            200,
            {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready", "trace_id": TRACE_ID},
        )
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value="sk-ant-0123456789"),
            mock.patch.object(team, "chat", return_value=controller) as chat,
        ):
            response = local.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )

        self.assertEqual(
            response.body,
            {"team_id": "team_1", "team_name": "Marketing", "reply": "Ready"},
        )
        call = chat.call_args
        self.assertEqual(call.args[1], {"message": "Hi", "files": [], "assistant_ids": []})
        self.assertEqual(call.kwargs["provider"], "anthropic")
        self.assertEqual(call.kwargs["api_key"], "sk-ant-0123456789")
        self.assertTrue(callable(call.kwargs["progress"]))

    def test_missing_controller_contract_fails_503_without_mocking_success(self) -> None:
        missing = team.TeamResponse(404, {"detail": "no such operation"})
        with (
            mock.patch.object(team, "get_inference", return_value=missing),
            mock.patch.object(models, "resolve_api_key") as resolve_key,
            mock.patch.object(team, "chat") as chat,
        ):
            response = local.turn(
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
                mock.patch.object(team, "get_inference", return_value=team.TeamResponse(200, body)),
                mock.patch.object(models, "resolve_api_key") as resolve_key,
                mock.patch.object(team, "chat") as chat,
            ):
                response = local.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(
                response,
                team.TeamResponse(502, {"code": "inference-response-invalid"}),
            )
            resolve_key.assert_not_called()
            chat.assert_not_called()

    def test_missing_model_credential_returns_a_stable_code_without_calling_controller(self) -> None:
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value=None),
            mock.patch.object(team, "chat") as chat,
        ):
            response = local.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})

        self.assertEqual(response, team.TeamResponse(409, {"code": "model-credential-missing"}))
        chat.assert_not_called()

    def test_controller_cannot_echo_the_private_key_to_browser(self) -> None:
        api_key = "sk-test-0123456789"
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        echoed = team.TeamResponse(
            502,
            {
                "error": f"provider rejected {api_key}",
                "code": "brain-runtime-failed",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value=api_key),
            mock.patch.object(team, "chat", return_value=echoed),
        ):
            response = local.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )
        self.assertEqual(response.status, 502)
        self.assertEqual(response.body, {"code": "brain-runtime-failed"})
        self.assertNotIn(api_key, json.dumps(response.body))

        echoed_reply = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": "Marketing",
                "reply": f"unexpected {api_key}",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value=api_key),
            mock.patch.object(team, "chat", return_value=echoed_reply),
        ):
            response = local.turn(
                "team_1",
                {"message": "Hi", "files": [], "assistant_ids": []},
            )
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_invalid_authoritative_team_name_is_not_projected(self) -> None:
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        for team_name in ("", " Marketing", "Marketing\nignore rules", "x" * 81, None):
            controller = team.TeamResponse(
                200,
                {"team_id": "team_1", "team_name": team_name, "reply": "Ready", "trace_id": TRACE_ID},
            )
            with (
                self.subTest(team_name=team_name),
                mock.patch.object(team, "get_inference", return_value=inference),
                mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(team, "chat", return_value=controller),
            ):
                response = local.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(response.status, 502)
            self.assertEqual(response.body, {"code": "chat-response-invalid"})

    def test_controller_identity_and_closed_turn_contract_fail_closed(self) -> None:
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
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
            {**valid, "reply": " \n\t"},
            {**valid, "reply": "unsafe\u0000reply"},
            {**valid, "reply": "x" * 60_001},
        )
        for controller_body in invalid:
            with (
                self.subTest(controller_body=controller_body),
                mock.patch.object(team, "get_inference", return_value=inference),
                mock.patch.object(models, "resolve_api_key", return_value="sk-test-0123456789"),
                mock.patch.object(team, "chat", return_value=team.TeamResponse(200, controller_body)),
            ):
                response = local.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
            self.assertEqual(response, team.TeamResponse(502, {"code": "chat-response-invalid"}))

    def test_private_key_in_team_name_is_rejected_without_echo(self) -> None:
        api_key = "sk-test-0123456789"
        inference = team.TeamResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "team_name": f"Marketing {api_key}",
                "reply": "Ready",
                "trace_id": TRACE_ID,
            },
        )
        with (
            mock.patch.object(team, "get_inference", return_value=inference),
            mock.patch.object(models, "resolve_api_key", return_value=api_key),
            mock.patch.object(team, "chat", return_value=controller),
        ):
            response = local.turn("team_1", {"message": "Hi", "files": [], "assistant_ids": []})
        self.assertEqual(response.status, 502)
        self.assertNotIn(api_key, json.dumps(response.body))

    def test_stop_projects_an_accepted_turn_without_overclaiming_power_confirmation(self) -> None:
        controller = team.TeamResponse(
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
        with mock.patch.object(team, "stop_chat", return_value=controller):
            response = local.stop("team_1")
        self.assertEqual(response, team.TeamResponse(200, {"team_id": "team_1", "stopped": True}))

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
                    team,
                    "stop_chat",
                    return_value=team.TeamResponse(200, controller_body),
                ),
            ):
                response = local.stop("team_1")
            self.assertEqual(
                response,
                team.TeamResponse(502, {"code": "chat-stop-response-invalid"}),
            )


if __name__ == "__main__":
    unittest.main()
