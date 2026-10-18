"""Security contracts for local model API keys: masked status, validated saves, and no route that resolves a key."""

import importlib
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class ModelProviderOperationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(root)
        cls.models = importlib.import_module("models")
        cls.methods = importlib.import_module("session.methods")

    def test_no_route_resolves_or_returns_a_model_key(self) -> None:
        routes = app_import.route_methods(self.admin_app)
        self.assertFalse(any("model" in path or "resolve" in path or "secret" in path for path, _method in routes))
        websocket_paths = {
            route.path for route in self.admin_app.app.routes if route.__class__.__name__ == "APIWebSocketRoute"
        }
        # The session socket, and the binary screen of a watched Browser task (ADR-0117), which carries no key.
        self.assertEqual(websocket_paths, {"/api/session/ws", "/api/teams/{team_id}/browser/views/{view_id}/stream"})

    def test_a_save_validates_the_key_with_its_provider(self) -> None:
        secret = "sk-test-" + str(123456789).zfill(10)
        expected = {"id": "openai", "configured": True}
        with mock.patch.object(self.models, "configure", return_value=expected) as configure:
            self.assertEqual(self.methods.save_model_key("openai", {"api_key": secret}), expected)
        configure.assert_called_once_with("openai", secret)

    def test_a_save_maps_rejection_and_unavailability_without_disclosing_the_key(self) -> None:
        secret = "sk-test-" + str(123456789).zfill(10)
        cases = (
            (self.models.ModelProviderError("model provider rejected API key"), 400),
            (self.models.ModelProviderUnavailableError("model provider validation is temporarily unavailable"), 503),
        )
        for error, expected_status in cases:
            with (
                self.subTest(expected_status=expected_status),
                mock.patch.object(self.models, "configure", side_effect=error),
                self.assertRaises(HTTPException) as caught,
            ):
                self.methods.save_model_key("openai", {"api_key": secret})
            self.assertEqual(caught.exception.status_code, expected_status)
            self.assertNotIn(secret, caught.exception.detail)

    def test_a_save_without_exactly_one_key_is_refused_before_any_validation(self) -> None:
        for body in ({}, {"api_key": "test-api-key", "extra": 1}):
            with (
                self.subTest(body=body),
                mock.patch.object(self.models, "configure") as configure,
                self.assertRaises(HTTPException) as caught,
            ):
                self.methods.save_model_key("openai", body)
            self.assertEqual(caught.exception.status_code, 400)
            configure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
