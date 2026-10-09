"""The Supervisor's TypeSafe key: custody, validation, routes, and its intent-classification-only hand-off."""

import asyncio
import hashlib
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from fastapi import HTTPException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

KEY = "tsk-test-0123456789abcdef"


def _request(body: object) -> Request:
    raw = json.dumps(body).encode()
    scope = {
        "type": "http",
        "method": "PUT",
        "path": "/api/decision-provider",
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())],
    }

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request(scope, receive)


class DecisionProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(cls.root)
        cls.decision = importlib.import_module("decision")
        cls.state = importlib.import_module("state")
        cls.models = importlib.import_module("models")

    def setUp(self) -> None:
        self.state.STORE_PATH = self.root / "admin.json"
        self.state.STORE_PATH.unlink(missing_ok=True)

    def test_a_verified_key_is_stored_masked_resolved_and_removed(self) -> None:
        self.assertEqual(self.decision.status(), {"provider": "typesafe", "configured": False, "masked": None})
        self.assertIsNone(self.decision.resolve())
        with mock.patch.object(self.models, "probe_status", return_value=200) as probe:
            self.assertEqual(
                self.decision.configure(KEY), {"provider": "typesafe", "configured": True, "masked": "••••cdef"}
            )
        probe.assert_called_once_with("api.typesafe.ai", "/v1/models", {"Authorization": f"Bearer {KEY}"})
        self.assertEqual(self.decision.resolve(), KEY)
        stored = json.loads(self.state.STORE_PATH.read_text())
        self.assertEqual(stored["decision_credential"]["api_key"], KEY)
        self.assertEqual(self.state.STORE_PATH.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(KEY, json.dumps(self.decision.status()))
        self.assertEqual(self.decision.remove()["configured"], False)
        self.assertIsNone(self.decision.resolve())

    def test_rejected_unavailable_and_malformed_keys_are_never_stored(self) -> None:
        for status_code, error in (
            (401, self.decision.DecisionProviderError),
            (403, self.decision.DecisionProviderError),
            (500, self.decision.DecisionProviderUnavailableError),
            (None, self.decision.DecisionProviderUnavailableError),
        ):
            with (
                self.subTest(status=status_code),
                mock.patch.object(self.models, "probe_status", return_value=status_code),
                self.assertRaises(error),
            ):
                self.decision.configure(KEY)
        with (
            mock.patch.object(self.models, "probe_status") as probe,
            self.assertRaises(self.decision.DecisionProviderError),
        ):
            self.decision.configure("short")
        probe.assert_not_called()
        self.assertIsNone(self.decision.resolve())

    def test_an_unverified_or_malformed_record_resolves_to_no_key(self) -> None:
        for record in ({"api_key": KEY}, {"api_key": KEY, "verified_at": 0}, {"api_key": "bad key", "verified_at": 1}):
            self.state.STORE_PATH.write_text(json.dumps({"decision_credential": record}))
            with self.subTest(record=record):
                self.assertIsNone(self.decision.resolve())
        self.state.STORE_PATH.write_text(json.dumps({"decision_credential": "broken"}))
        with self.assertRaises(RuntimeError):
            self.decision.resolve()

    def test_routes_are_local_session_gated_and_map_failures(self) -> None:
        routes = app_import.route_methods(self.admin_app)
        for method in ("GET", "PUT", "DELETE"):
            self.assertIn(("/api/decision-provider", method), routes)
        self.assertNotIn("/api/decision-provider", self.admin_app.OPEN_API)
        route = self.decision._configure_route
        with mock.patch.object(self.decision, "configure", return_value={"configured": True}) as configure:
            self.assertEqual(asyncio.run(route(_request({"api_key": KEY}))), {"configured": True})
        configure.assert_called_once_with(KEY)
        for body, error, status in (
            ({"api_key": KEY, "extra": 1}, None, 400),
            ({"api_key": KEY}, self.decision.DecisionProviderError("TypeSafe rejected API key"), 400),
            ({"api_key": KEY}, self.decision.DecisionProviderUnavailableError("down"), 503),
        ):
            with (
                self.subTest(status=status),
                mock.patch.object(self.decision, "configure", side_effect=error),
                self.assertRaises(HTTPException) as raised,
            ):
                asyncio.run(route(_request(body)))
            self.assertEqual(raised.exception.status_code, status)


class DecisionHandOffTests(unittest.TestCase):
    def test_only_classification_carries_the_decision_key(self) -> None:
        local = importlib.import_module("chat.local")
        team = importlib.import_module("team.bridge")
        ordinary = team.TeamResponse(
            200,
            {
                "team_id": "team_1",
                "intent": "ordinary-task",
                "query": "",
                "assistant_ids": [],
                "reply": "",
                "task_follows": False,
            },
        )
        with (
            mock.patch.object(local, "model_credential", return_value=("openai", "sk-test-0123456789")),
            mock.patch.object(local.decision, "resolve", return_value=KEY),
            mock.patch.object(team, "intent_route", return_value=ordinary) as route,
        ):
            local.intent_route("team_1", "oi", None, [], local.IntentRouteContext(locale="pt"))
            self.assertEqual(route.call_args.kwargs["decision_key"], KEY)
            local.intent_route(
                "team_1",
                "cloudflare",
                "assistant-uninstall",
                [{"id": "cloudflare", "name": "Cloudflare", "summary": ""}],
                local.IntentRouteContext(locale="pt"),
            )
            self.assertIsNone(route.call_args.kwargs["decision_key"])

    def test_the_pinned_protocol_admits_only_a_typesafe_decision_claim(self) -> None:
        contract = importlib.import_module("protocol.http.v1.supervisor")
        claims = {
            "v": 1,
            "aud": contract.ASSERTION_AUDIENCE,
            "sub": "a" * 32,
            "authority": "session",
            "authority_sha256": "b" * 64,
            "jti": "c" * 32,
            "iat": 2_200_000_000,
            "exp": 2_200_000_015,
            "method": "POST",
            "path": "/v1/teams/team_1/chat/intent-route",
            "body": {"kind": "json", "length": 2, "sha256": "d" * 64},
            "decision": {"provider": "typesafe", "key_sha256": "f" * 64},
        }
        self.assertEqual(contract.canonical_claims(claims)["decision"], claims["decision"])
        for decision in ({"provider": "openai", "key_sha256": "f" * 64}, {"provider": "typesafe"}):
            with self.subTest(decision=decision), self.assertRaises(contract.SupervisorAssertionError):
                contract.canonical_claims({**claims, "decision": decision})

    def test_the_header_and_its_bound_digest_travel_together(self) -> None:
        transport = importlib.import_module("team.transport")
        supervisor = importlib.import_module("supervisor")
        self.assertIsNone(supervisor.decision_binding(None))
        self.assertEqual(
            supervisor.decision_binding(KEY),
            {"provider": "typesafe", "key_sha256": hashlib.sha256(KEY.encode()).hexdigest()},
        )
        bindings = transport._RequestBindings(("openai", "sk-test-0123456789"), decision_key=KEY)
        with (
            mock.patch.object(transport, "_team_token", return_value="machine-bearer"),
            mock.patch.object(transport, "_local_assertion", return_value=None) as assertion,
        ):
            headers = transport._request_headers(
                "POST",
                "/v1/teams/team_1/chat/intent-route",
                b"{}",
                accept="application/json",
                content_type="application/json",
                filename=None,
                bindings=bindings,
            )
        self.assertEqual(headers["X-Shimpz-Decision-Api-Key"], KEY)
        self.assertIs(assertion.call_args.kwargs["bindings"], bindings)
        for invalid in ("short", "tsk-with space-0123456789", "tsk-ümlaut-0123456789ab"):
            with (
                self.subTest(key=invalid),
                mock.patch.object(transport, "_team_token", return_value="machine-bearer"),
                self.assertRaises(OSError),
            ):
                transport._request_headers(
                    "POST",
                    "/v1/teams/team_1/chat/intent-route",
                    b"{}",
                    accept="application/json",
                    content_type="application/json",
                    filename=None,
                    bindings=transport._RequestBindings(("openai", "sk-test-0123456789"), decision_key=invalid),
                )


if __name__ == "__main__":
    unittest.main()
