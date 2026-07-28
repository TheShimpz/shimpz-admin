"""Fast contracts for the local Admin-owned model credential boundary."""

from __future__ import annotations

import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import adminstore
import modelproviders


class ModelProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_store = adminstore.STORE_PATH
        adminstore.STORE_PATH = Path(self.temporary.name) / "admin.json"

    def tearDown(self) -> None:
        adminstore.STORE_PATH = self.previous_store
        self.temporary.cleanup()

    def test_status_masks_key_and_internal_resolver_is_backend_only(self) -> None:
        secret = "sk-test-0123456789abcdef"
        with mock.patch.object(modelproviders, "_validate_api_key"):
            configured = modelproviders.configure("OpenAI", secret)

        self.assertEqual(configured["masked"], "••••cdef")
        self.assertNotIn(secret, json.dumps(modelproviders.status()))
        self.assertEqual(modelproviders.resolve_api_key("openai"), secret)
        self.assertEqual(stat.S_IMODE(adminstore.STORE_PATH.stat().st_mode), 0o600)

    def test_status_exposes_the_closed_catalog_with_exact_base_prices(self) -> None:
        status = modelproviders.status()

        self.assertEqual(
            status,
            {
                "providers": [
                    {
                        "id": "openai",
                        "title": "OpenAI",
                        "default_model": "gpt-5.6-terra",
                        "models": [
                            {
                                "id": "gpt-5.6-sol",
                                "title": "GPT-5.6 Sol",
                                "input_usd_per_million_cents": 500,
                                "output_usd_per_million_cents": 3_000,
                            },
                            {
                                "id": "gpt-5.6-terra",
                                "title": "GPT-5.6 Terra",
                                "input_usd_per_million_cents": 250,
                                "output_usd_per_million_cents": 1_500,
                            },
                            {
                                "id": "gpt-5.6-luna",
                                "title": "GPT-5.6 Luna",
                                "input_usd_per_million_cents": 100,
                                "output_usd_per_million_cents": 600,
                            },
                            {
                                "id": "gpt-5.5",
                                "title": "GPT-5.5",
                                "input_usd_per_million_cents": 500,
                                "output_usd_per_million_cents": 3_000,
                            },
                        ],
                        "configured": False,
                        "masked": None,
                    },
                    {
                        "id": "anthropic",
                        "title": "Anthropic",
                        "default_model": "claude-sonnet-5",
                        "models": [
                            {
                                "id": "claude-fable-5",
                                "title": "Claude Fable 5",
                                "input_usd_per_million_cents": 1_000,
                                "output_usd_per_million_cents": 5_000,
                            },
                            {
                                "id": "claude-opus-4-8",
                                "title": "Claude Opus 4.8",
                                "input_usd_per_million_cents": 500,
                                "output_usd_per_million_cents": 2_500,
                            },
                            {
                                "id": "claude-sonnet-5",
                                "title": "Claude Sonnet 5",
                                "input_usd_per_million_cents": 300,
                                "output_usd_per_million_cents": 1_500,
                            },
                            {
                                "id": "claude-haiku-4-5-20251001",
                                "title": "Claude Haiku 4.5",
                                "input_usd_per_million_cents": 100,
                                "output_usd_per_million_cents": 500,
                            },
                        ],
                        "configured": False,
                        "masked": None,
                    },
                ]
            },
        )
        status["providers"][0]["models"][0]["id"] = "mutated"
        self.assertEqual(modelproviders.status()["providers"][0]["models"][0]["id"], "gpt-5.6-sol")

    def test_provider_removal_preserves_other_keys(self) -> None:
        with mock.patch.object(modelproviders, "_validate_api_key"):
            modelproviders.configure("openai", "sk-openai-0123456789")
            modelproviders.configure("anthropic", "sk-ant-0123456789")

        removed = modelproviders.remove("openai")

        self.assertFalse(removed["configured"])
        self.assertIsNone(modelproviders.resolve_api_key("openai"))
        self.assertEqual(modelproviders.resolve_api_key("anthropic"), "sk-ant-0123456789")

    def test_invalid_provider_and_key_fail_closed(self) -> None:
        for provider, secret in (
            ("codex", "sk-test-0123456789"),
            ("claude-code", "sk-test-0123456789"),
            ("openai", " short "),
            ("anthropic", "line-one\nline-two-secret"),
        ):
            with self.subTest(provider=provider, secret=secret), self.assertRaises(modelproviders.ModelProviderError):
                modelproviders.configure(provider, secret)

    def test_validation_uses_each_fixed_tls_endpoint_and_required_headers(self) -> None:
        cases = (
            (
                "openai",
                "sk-openai-0123456789",
                "api.openai.com",
                {"Authorization": "Bearer sk-openai-0123456789"},
            ),
            (
                "anthropic",
                "sk-ant-0123456789",
                "api.anthropic.com",
                {
                    "x-api-key": "sk-ant-0123456789",
                    "anthropic-version": "2023-06-01",
                },
            ),
        )
        for provider, secret, host, headers in cases:
            response = mock.Mock(status=204)
            connection = mock.Mock()
            connection.getresponse.return_value = response
            tls_context = object()
            with (
                self.subTest(provider=provider),
                mock.patch.object(modelproviders.ssl, "create_default_context", return_value=tls_context),
                mock.patch.object(modelproviders.http.client, "HTTPSConnection", return_value=connection) as connect,
                mock.patch.object(adminstore.time, "time", return_value=1_784_404_000),
            ):
                configured = modelproviders.configure(provider, secret)

            connect.assert_called_once_with(
                host,
                port=443,
                timeout=modelproviders.VALIDATION_TIMEOUT_SECONDS,
                context=tls_context,
            )
            connection.request.assert_called_once_with("GET", "/v1/models", headers=headers)
            response.read.assert_not_called()
            response.getheaders.assert_not_called()
            response.close.assert_called_once_with()
            connection.close.assert_called_once_with()
            self.assertTrue(configured["configured"])
            self.assertEqual(
                adminstore.model_credentials()[provider],
                {"api_key": secret, "verified_at": 1_784_404_000},
            )

    def test_provider_rejection_does_not_persist_or_disclose_the_secret(self) -> None:
        secret = "sk-rejected-0123456789"
        for status_code in (401, 403):
            response = mock.Mock(status=status_code)
            connection = mock.Mock()
            connection.getresponse.return_value = response
            with (
                self.subTest(status_code=status_code),
                mock.patch.object(modelproviders.http.client, "HTTPSConnection", return_value=connection),
                self.assertRaises(modelproviders.ModelProviderError) as caught,
            ):
                modelproviders.configure("openai", secret)

            self.assertNotIn(secret, str(caught.exception))
            self.assertNotIn("openai", adminstore.model_credentials())
            response.read.assert_not_called()

    def test_provider_unavailability_preserves_the_previous_verified_key(self) -> None:
        previous = "sk-previous-0123456789"
        replacement = "sk-replacement-0123456789"
        with mock.patch.object(adminstore.time, "time", return_value=1_784_403_000):
            adminstore.set_model_api_key("openai", previous)

        failures = (
            (mock.Mock(status=429), None),
            (mock.Mock(status=302), None),
            (mock.Mock(status=500), None),
            (None, TimeoutError("validation timed out")),
            (None, OSError("network unavailable")),
        )
        for response, failure in failures:
            connection = mock.Mock()
            if failure is None:
                connection.getresponse.return_value = response
            else:
                connection.getresponse.side_effect = failure
            with (
                self.subTest(status=getattr(response, "status", None), failure=type(failure).__name__),
                mock.patch.object(modelproviders.http.client, "HTTPSConnection", return_value=connection),
                self.assertRaises(modelproviders.ModelProviderUnavailableError) as caught,
            ):
                modelproviders.configure("openai", replacement)

            self.assertNotIn(replacement, str(caught.exception))
            self.assertEqual(modelproviders.resolve_api_key("openai"), previous)
            self.assertEqual(adminstore.model_credentials()["openai"]["verified_at"], 1_784_403_000)
            if response is not None:
                response.read.assert_not_called()

    def test_legacy_or_secretless_records_are_not_configured_or_resolved(self) -> None:
        legacy_secret = "sk-legacy-0123456789"
        adminstore._write(
            {
                "model_credentials": {
                    "openai": {"api_key": legacy_secret, "updated": 1_784_400_000},
                    "anthropic": {"verified_at": 1_784_400_000},
                }
            }
        )

        providers = {item["id"]: item for item in modelproviders.status()["providers"]}
        self.assertFalse(providers["openai"]["configured"])
        self.assertIsNone(providers["openai"]["masked"])
        self.assertFalse(providers["anthropic"]["configured"])
        self.assertIsNone(modelproviders.resolve_api_key("openai"))
        self.assertIsNone(modelproviders.resolve_api_key("anthropic"))

    def test_model_must_belong_to_its_provider(self) -> None:
        for provider, model in (
            ("openai", "claude-sonnet-5"),
            ("anthropic", "gpt-5.6-terra"),
            ("openai", "gpt-5.7"),
        ):
            with self.subTest(provider=provider, model=model), self.assertRaises(modelproviders.ModelProviderError):
                modelproviders.canonical_model(provider, model)


if __name__ == "__main__":
    unittest.main()
