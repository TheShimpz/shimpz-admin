"""Fast contracts for the private local model-key hand-off and browser-safe chat projection."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
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


def account_requirement() -> dict[str, object]:
    return {
        "assistant_id": "shimpz-cloudflare",
        "assistant_name": "Shimpz Cloudflare",
        "account_id": "x-account",
        "provider": "x",
        "name": "X account",
        "summary": "Lets approved Powers access the connected X account.",
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
    def test_account_challenge_projects_only_public_consent_metadata(self) -> None:
        body = {
            "team_id": "team_1",
            "status": "accounts-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [account_requirement()],
            "trace_id": TRACE_ID,
        }

        response = localchat._project_account_challenge(teams.DriverResponse(428, body), "team_1")

        self.assertEqual(
            response,
            teams.DriverResponse(
                428,
                {key: value for key, value in body.items() if key != "trace_id"},
            ),
        )
        self.assertNotIn("token", json.dumps(response.body).lower())
        self.assertNotIn("client_secret", json.dumps(response.body).lower())

    def test_account_challenge_fails_closed_on_ambiguous_or_private_data(self) -> None:
        valid = {
            "team_id": "team_1",
            "status": "accounts-required",
            "turn_id": CHALLENGE_ID,
            "challenge_id": CHALLENGE_ID,
            "expires_in": 300,
            "requirements": [account_requirement()],
            "trace_id": TRACE_ID,
        }
        requirement = account_requirement()
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
                response = localchat._project_account_challenge(teams.DriverResponse(428, body), "team_1")
            self.assertEqual(
                response,
                teams.DriverResponse(502, {"code": "account-challenge-response-invalid"}),
            )

    def test_turn_preserves_account_before_later_gates(self) -> None:
        inference = teams.DriverResponse(200, {"provider": "openai", "model": "gpt-5.5"})
        controller = teams.DriverResponse(
            428,
            {
                "team_id": "team_1",
                "status": "accounts-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [account_requirement()],
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
                {"message": "Post an update", "files": [], "assistant_ids": ["shimpz-cloudflare"]},
            )

        self.assertEqual(response.status, 428)
        self.assertEqual(response.body["status"], "accounts-required")
        self.assertEqual(response.body["requirements"], [account_requirement()])

    def test_pending_account_is_team_bound_and_none_is_closed(self) -> None:
        pending = teams.DriverResponse(
            200,
            {
                "team_id": "team_1",
                "status": "accounts-required",
                "turn_id": CHALLENGE_ID,
                "challenge_id": CHALLENGE_ID,
                "expires_in": 300,
                "requirements": [account_requirement()],
                "trace_id": TRACE_ID,
            },
        )
        with mock.patch.object(teams, "pending_chat_accounts", return_value=pending):
            projected = localchat.pending_accounts("team_1")
        self.assertEqual(projected.body["status"], "accounts-required")
        self.assertNotIn("trace_id", projected.body)

        none = teams.DriverResponse(200, {"team_id": "team_1", "status": "none", "trace_id": TRACE_ID})
        with mock.patch.object(teams, "pending_chat_accounts", return_value=none):
            self.assertEqual(
                localchat.pending_accounts("team_1"),
                teams.DriverResponse(200, {"team_id": "team_1", "status": "none"}),
            )

        cross_team = teams.DriverResponse(200, {**none.body, "team_id": "team_2"})
        with mock.patch.object(teams, "pending_chat_accounts", return_value=cross_team):
            self.assertEqual(
                localchat.pending_accounts("team_1"),
                teams.DriverResponse(502, {"code": "account-challenge-response-invalid"}),
            )

    def test_account_resume_rejects_augmented_or_invalid_payload_before_transport(self) -> None:
        invalid = (
            {},
            {"challenge_id": "short"},
            {"challenge_id": CHALLENGE_ID, "authorization_code": "must-not-cross"},
            {"challenge_id": CHALLENGE_ID, "access_token": "must-not-cross"},
        )
        with mock.patch.object(teams, "_call") as transport:
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(teams.TeamRequestError):
                    teams.resume_chat_accounts(
                        "team_1",
                        payload,
                        provider="openai",
                        api_key="sk-test-0123456789",
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
