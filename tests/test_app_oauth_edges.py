"""OAuth route rejection and backend-only UI fallback edges for the Admin application."""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import app_import
from http_request import http_request, remote
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))


def _request(*, cookie: str = "token") -> Request:
    headers = [(b"cookie", f"shimpz_admin={cookie}".encode())] if cookie else []
    return http_request("/api/test", remote("192.0.2.40"), headers=headers)


class AppOAuthEdgeTests(app_import.RouteStatusAssertions):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.environment = app_import.environment(root)
        cls.admin_app = app_import.load_app(root)

    def _body(self, **payload: object):
        """Patch the bounded JSON body the route reads with exactly this object."""
        return mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload))

    @staticmethod
    def preparation():
        return types.SimpleNamespace(token="f" * 64, session_binding="b" * 43)

    def test_authorization_maps_provider_team_and_handoff_rejections(self) -> None:
        request = _request()
        unavailable = self.admin_app.team.TeamResponse(503, {"error": "offline"})
        preparation = self.preparation()
        with (
            self._body(assistant_id="shimpz-cloudflare", integration_id="cloudflare"),
            mock.patch.object(self.admin_app, "_local_oauth_authorization_mode", return_value="loopback"),
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "issue", return_value=preparation),
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "discard") as discard,
            mock.patch.object(
                self.admin_app.integrations,
                "start_local_assistant_integration_authorization",
                return_value=unavailable,
            ),
        ):
            response = asyncio.run(self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request))
        self.assertEqual(response.status_code, 503)
        discard.assert_called_once_with(preparation.token)

        with (
            self._body(assistant_id="shimpz-cloudflare", integration_id="cloudflare"),
            mock.patch.object(self.admin_app, "_local_oauth_authorization_mode", return_value="loopback"),
        ):
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_authorize("Bad", "a" * 32, request),
            )

        with (
            self._body(assistant_id="shimpz-cloudflare", integration_id="cloudflare"),
            mock.patch.object(self.admin_app, "_local_oauth_authorization_mode", return_value="loopback"),
            mock.patch.object(
                self.admin_app.OAUTH_HANDOFFS,
                "issue",
                side_effect=self.admin_app.handoff_store.OAuthHandoffError("conflict"),
            ),
        ):
            self.assert_status(
                409,
                self.admin_app.team_assistant_integration_authorize("team_1", "a" * 32, request),
            )

    def test_completion_and_cancellation_validate_shape_identity_and_handoff_state(self) -> None:
        request = _request()
        with self._body():
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_complete("team_1", "a" * 32, request),
            )
        with self._body(completion_code="code"):
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_complete("Bad", "a" * 32, request),
            )

        with self._body(unexpected=True):
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_cancel("team_1", "a" * 32, request),
            )
        with (
            self._body(),
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "cancel", return_value=None),
        ):
            response = asyncio.run(self.admin_app.team_assistant_integration_cancel("team_1", "a" * 32, request))
        self.assertEqual(response.status_code, 204)

        with self._body():
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_cancel("Bad", "a" * 32, request),
            )

        with (
            self._body(),
            mock.patch.object(
                self.admin_app.OAUTH_HANDOFFS,
                "cancel",
                side_effect=self.admin_app.handoff_store.OAuthHandoffError("conflict"),
            ),
        ):
            self.assert_status(
                409,
                self.admin_app.team_assistant_integration_cancel("team_1", "a" * 32, request),
            )

        rejected = self.admin_app.team.TeamResponse(409, {"error": "not pending"})
        with (
            self._body(),
            mock.patch.object(self.admin_app.OAUTH_HANDOFFS, "cancel", return_value="binding"),
            mock.patch.object(
                self.admin_app.integrations,
                "cancel_local_assistant_integration_authorization",
                return_value=rejected,
            ),
        ):
            response = asyncio.run(self.admin_app.team_assistant_integration_cancel("team_1", "a" * 32, request))
        self.assertEqual(response.status_code, 409)

    def test_disconnect_and_callback_map_invalid_team_responses(self) -> None:
        with mock.patch.object(
            self.admin_app.integrations,
            "disconnect_assistant_integration",
            side_effect=self.admin_app.team.TeamRequestError("invalid"),
        ):
            self.assert_status(
                400,
                self.admin_app.team_assistant_integration_disconnect("team_1", "assistant", "integration"),
            )

        rejected = self.admin_app.team.TeamResponse(409, {"error": "connected"})
        with mock.patch.object(
            self.admin_app.integrations,
            "disconnect_assistant_integration",
            return_value=rejected,
        ):
            response = asyncio.run(
                self.admin_app.team_assistant_integration_disconnect("team_1", "assistant", "integration")
            )
        self.assertEqual(response.status_code, 409)

        callback = _request(cookie="binding")
        callback.scope["query_string"] = ("state=" + "b" * 43 + "&claim=" + "c" * 64).encode()
        with (
            mock.patch.object(self.admin_app, "_is_oauth_origin", return_value=True),
            mock.patch.object(
                self.admin_app.integrations,
                "complete_cloudflare_oauth_callback",
                side_effect=self.admin_app.team.TeamRequestError("invalid"),
            ),
        ):
            failed = asyncio.run(self.admin_app.oauth_cloudflare_callback(callback))
        self.assertIn("oauth=callback-failed", failed.headers["location"])

        with (
            mock.patch.object(self.admin_app, "_is_oauth_origin", return_value=True),
            mock.patch.object(
                self.admin_app.integrations,
                "complete_cloudflare_oauth_callback",
                return_value=self.admin_app.team.TeamResponse(503, {"error": "offline"}),
            ),
        ):
            rejected_callback = asyncio.run(self.admin_app.oauth_cloudflare_callback(callback))
        self.assertIn("oauth=callback-failed", rejected_callback.headers["location"])

    def test_backend_only_import_registers_the_explicit_no_ui_response(self) -> None:
        module_name = "app_without_built_ui_for_coverage"
        spec = importlib.util.spec_from_file_location(module_name, BACKEND / "app.py")
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        self.addCleanup(sys.modules.pop, module_name, None)
        original_is_dir = Path.is_dir

        def without_ui(path: Path) -> bool:
            if path.name == "build" and path.parent.name == "frontend":
                return False
            return original_is_dir(path)

        with (
            mock.patch.dict(os.environ, self.environment),
            mock.patch.object(Path, "is_dir", without_ui),
        ):
            spec.loader.exec_module(module)
        response = asyncio.run(module.no_ui())
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"UI not built", response.body)


if __name__ == "__main__":
    unittest.main()
