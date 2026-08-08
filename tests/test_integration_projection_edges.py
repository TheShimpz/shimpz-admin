"""Closed browser projections for Assistant integration metadata and OAuth results."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from integrations import assistants


def _authorization_url(**overrides: str) -> str:
    fields = {
        "scope": "dns.read dns.write offline_access zone.read",
        "state": "a" * 43,
        "code_challenge": "b" * 43,
        "callback": "hosted",
    }
    fields.update(overrides)
    return "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(fields)


def _integration(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "assistant_id": "shimpz-cloudflare",
        "assistant_name": "Shimpz Cloudflare",
        "id": "cloudflare",
        "provider": "cloudflare",
        "name": "Cloudflare",
        "summary": "Access Cloudflare.",
        "scopes": ["dns.read", "zone.read"],
        "status": "connected",
        "integration": {"id": "account", "name": "Account", "username": None},
        "expires_at": None,
    }
    value.update(overrides)
    return value


class IntegrationProjectionEdgeTests(unittest.TestCase):
    def test_scalar_and_nested_canonicalizers_reject_invalid_values(self) -> None:
        operations = (
            lambda: assistants._canonical_team_id("Bad"),
            lambda: assistants.canonical_oauth_binding("bad"),
            lambda: assistants.canonical_oauth_claim("bad"),
            lambda: assistants._integration_scopes([]),
            lambda: assistants._integration_scopes(["bad scope"]),
            lambda: assistants._integration_scopes(["dns.read", "dns.read"]),
            lambda: assistants._integration_identity({}),
            lambda: assistants._integration_expiry("bad"),
            lambda: assistants._integration_expiry("2026-13-01T00:00:00Z"),
        )
        for operation in operations:
            with self.assertRaises((assistants.TeamRequestError, ValueError)):
                operation()
        self.assertIsNone(assistants._integration_identity(None))
        self.assertIsNone(assistants._integration_expiry(None))

        with mock.patch.object(assistants, "datetime") as parser:
            parser.fromisoformat.return_value = mock.Mock(tzinfo=None)
            with self.assertRaisesRegex(ValueError, "invalid OAuth expiry"):
                assistants._integration_expiry("2026-01-01T00:00:00Z")

    def test_inventory_projection_rejects_status_envelope_size_and_duplicates(self) -> None:
        upstream_error = assistants.TeamResponse(503, {"detail": "offline"})
        self.assertEqual(assistants._project_integration_inventory(upstream_error, "team_1"), upstream_error)

        invalid = (
            {"team_id": "team_2", "integrations": [], "trace_id": "a" * 32},
            {"team_id": "team_1", "integrations": "bad", "trace_id": "a" * 32},
            {
                "team_id": "team_1",
                "integrations": [_integration(), _integration()],
                "trace_id": "a" * 32,
            },
            {
                "team_id": "team_1",
                "integrations": [_integration(status="unknown")],
                "trace_id": "a" * 32,
            },
        )
        for body in invalid:
            with self.subTest(body=body):
                projected = assistants._project_integration_inventory(assistants.TeamResponse(200, body), "team_1")
            self.assertEqual(projected.status, 502)

    def test_authorization_url_and_response_fail_closed(self) -> None:
        wrong_fields = "https://shimpz.com/api/oauth/cloudflare/start?" + urlencode(
            {
                "scope": "dns.read offline_access zone.read",
                "state": "a" * 43,
                "code_challenge": "b" * 43,
                "wrong": "hosted",
            }
        )
        invalid = (
            None,
            "https://shimpz.com:bad/api/oauth/cloudflare/start?x=1",
            wrong_fields,
            _authorization_url(callback="loopback"),
            _authorization_url(scope="dns.write dns.read"),
            _authorization_url(scope="dns.read dns.read"),
            _authorization_url(scope="account.write"),
            _authorization_url(scope=""),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                assistants._trusted_cloudflare_authorization_url(value, "hosted")

        read_only = _authorization_url(scope="dns.read offline_access zone.read")
        self.assertEqual(
            assistants._trusted_cloudflare_authorization_url(read_only, "hosted"),
            read_only,
        )

        upstream_error = assistants.TeamResponse(503, {"detail": "offline"})
        self.assertEqual(assistants._project_authorization_response(upstream_error, "hosted"), upstream_error)

    def test_cancellation_disconnect_and_callback_reject_upstream_contract_drift(self) -> None:
        upstream_error = assistants.TeamResponse(503, {"detail": "offline"})
        invalid = assistants.TeamResponse(200, {"unexpected": True})
        invalid_connected = assistants.TeamResponse(
            200,
            {
                "connected": False,
                "team_id": "team_1",
                "assistant_id": "assistant",
                "integration_id": "integration",
                "trace_id": "a" * 32,
            },
        )
        with mock.patch.object(
            assistants.transport,
            "_call",
            side_effect=[upstream_error, invalid],
        ):
            self.assertEqual(
                assistants.cancel_local_assistant_integration_authorization(
                    "team_1",
                    "a" * 32,
                    "b" * 43,
                ),
                upstream_error,
            )
            self.assertEqual(
                assistants.cancel_local_assistant_integration_authorization(
                    "team_1",
                    "a" * 32,
                    "b" * 43,
                ).status,
                502,
            )

        with mock.patch.object(
            assistants.transport,
            "_call",
            side_effect=[upstream_error, invalid],
        ):
            self.assertEqual(
                assistants.disconnect_assistant_integration("team_1", "assistant", "integration"),
                upstream_error,
            )
            self.assertEqual(
                assistants.disconnect_assistant_integration("team_1", "assistant", "integration").status,
                502,
            )

        with mock.patch.object(
            assistants.transport,
            "_call",
            side_effect=[upstream_error, invalid, invalid_connected],
        ):
            self.assertEqual(
                assistants.complete_cloudflare_oauth_callback(
                    state="a" * 43,
                    claim="b" * 64,
                    session_binding="c" * 43,
                ),
                upstream_error,
            )
            self.assertEqual(
                assistants.complete_cloudflare_oauth_callback(
                    state="a" * 43,
                    claim="b" * 64,
                    session_binding="c" * 43,
                ).status,
                502,
            )
            self.assertEqual(
                assistants.complete_cloudflare_oauth_callback(
                    state="a" * 43,
                    claim="b" * 64,
                    session_binding="c" * 43,
                ).status,
                502,
            )


if __name__ == "__main__":
    unittest.main()
