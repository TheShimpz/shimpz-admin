"""Bounded JSON and thin Team route edges for the Admin HTTP application."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from http_request import http_request, json_headers, remote


def _request(
    path: str = "/api/test",
    *,
    body: bytes = b"",
    headers: list[tuple[bytes, bytes]] | None = None,
    cookie: str = "",
) -> Request:
    request_headers = list(headers or [])
    if cookie:
        request_headers.append((b"cookie", f"shimpz_admin={cookie}".encode()))
    return http_request(path, remote("192.0.2.20"), body=body, headers=request_headers)


def _json_request(payload: object, *, cookie: str = "") -> Request:
    body = json.dumps(payload).encode()
    return _request(body=body, headers=json_headers(body), cookie=cookie)


class AppRouteEdgeTests(app_import.RouteStatusAssertions):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(root)
        app_import.replace_for_class(cls, cls.admin_app.chat_history, "STORE_PATH", root / "chat-history.sqlite3")

    def assert_sync_status(self, expected: int, action) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            action()
        self.assertEqual(raised.exception.status_code, expected)

    def test_team_response_and_model_routes_map_domain_rejections(self) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            self.admin_app._team_response(lambda: (_ for _ in ()).throw(self.admin_app.team.TeamRequestError("bad")))
        self.assertEqual(raised.exception.status_code, 400)

        with mock.patch.object(self.admin_app.models, "status", return_value={"providers": []}):
            self.assertEqual(self.admin_app.model_providers_status(), {"providers": []})
        with mock.patch.object(self.admin_app.models, "remove", return_value={"configured": False}):
            self.assertEqual(self.admin_app.model_provider_delete("openai"), {"configured": False})
        with mock.patch.object(
            self.admin_app.models,
            "remove",
            side_effect=self.admin_app.models.ModelProviderError("invalid provider"),
        ):
            self.assert_sync_status(400, lambda: self.admin_app.model_provider_delete("invalid"))

    def test_platform_release_route_is_a_read_only_local_projection(self) -> None:
        status = {
            "release": f"ghcr.io/theshimpz/shimpz-local-release@sha256:{'a' * 64}",
            "ordinal": 42,
            "checked_at": 1_786_229_541,
            "outcome": "current",
        }
        with mock.patch.object(self.admin_app.platform_release, "read_status", return_value=status):
            self.assertEqual(
                self.admin_app.platform_release.status_response(),
                {**status, "checked_at": "2026-08-08T22:52:21Z"},
            )
        with mock.patch.object(
            self.admin_app.platform_release,
            "read_status",
            side_effect=self.admin_app.platform_release.PlatformReleaseUnavailableError,
        ):
            self.assert_sync_status(503, self.admin_app.platform_release.status_response)

    def test_bounded_json_rejects_media_length_stream_and_document_violations(self) -> None:
        self.assert_status(415, self.admin_app._bounded_json_object(_request(body=b"{}")))
        self.assert_status(
            400,
            self.admin_app._bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json"), (b"content-length", b"x")])
            ),
        )
        self.assert_status(
            413,
            self.admin_app._bounded_json_object(
                _request(
                    body=b"{}",
                    headers=[(b"content-type", b"application/json"), (b"content-length", b"3")],
                ),
                max_bytes=2,
            ),
        )
        self.assert_status(
            413,
            self.admin_app._bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json")]),
                max_bytes=1,
            ),
        )
        for body in (b"{", b'{"key":1,"key":2}', b'{"key":NaN}', b'{"key":[1e999]}'):
            with self.subTest(body=body):
                self.assert_status(
                    400,
                    self.admin_app._bounded_json_object(
                        _request(body=body, headers=[(b"content-type", b"application/json")])
                    ),
                )
        self.assert_status(
            400,
            self.admin_app._bounded_json_object(_request(body=b"[]", headers=[(b"content-type", b"application/json")])),
        )

    def test_team_creation_validates_shape_and_logs_only_successful_creation(self) -> None:
        invalid = (
            ({"name": "Marketing"}, 400),
            ({"team_name": 1}, 400),
            ({"team_name": "  "}, 400),
        )
        for payload, expected in invalid:
            with self.subTest(payload=payload):
                self.assert_sync_status(expected, lambda payload=payload: self.admin_app.teams_create(payload))

        with mock.patch.object(self.admin_app.team, "to_team_id", return_value=""):
            self.assert_sync_status(400, lambda: self.admin_app.teams_create({"team_name": "!!!"}))

        with (
            mock.patch.object(
                self.admin_app.team,
                "create",
                return_value=self.admin_app.team.TeamResponse(201, {"team_id": "marketing"}),
            ),
            mock.patch.object(self.admin_app.log, "info") as logged,
        ):
            response = self.admin_app.teams_create({"team_name": " Marketing "})
        self.assertEqual(response.status_code, 201)
        logged.assert_called_once_with("team created: %s", "marketing")

        with mock.patch.object(
            self.admin_app.team,
            "create",
            return_value=self.admin_app.team.TeamResponse(409, {"error": "exists"}),
        ):
            self.assertEqual(self.admin_app.teams_create({"team_name": "Marketing"}).status_code, 409)

    def test_new_local_team_clears_only_stale_history_for_its_id(self) -> None:
        created = self.admin_app.team.TeamResponse(
            201,
            {"team_id": "marketing", "team_name": "Marketing", "status": "running", "created": True},
        )
        existing = self.admin_app.team.TeamResponse(
            200,
            {"team_id": "marketing", "team_name": "Marketing", "status": "running", "created": False},
        )
        with (
            mock.patch.object(self.admin_app.team, "create", side_effect=(created, existing)),
            mock.patch.object(self.admin_app.chat_history, "clear_team", return_value=2) as cleared,
        ):
            self.assertEqual(self.admin_app.teams_create({"team_name": "Marketing"}).status_code, 201)
            self.assertEqual(self.admin_app.teams_create({"team_name": "Marketing"}).status_code, 200)
        cleared.assert_called_once_with("marketing")

    def test_local_team_deletion_validates_confirmation_and_authority_failures(self) -> None:
        request = _json_request({}, cookie="token")
        cases = (({"team_name": "Marketing"}, 400), ({"team_name": 1, "password": "secret"}, 400))
        for payload, expected in cases:
            with (
                self.subTest(payload=payload),
                mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            ):
                self.assert_status(expected, self.admin_app.teams_destroy("team_1", request))

        with mock.patch.object(
            self.admin_app,
            "_bounded_json_object",
            new=mock.AsyncMock(return_value={"team_name": "Marketing", "password": ""}),
        ):
            self.assert_status(400, self.admin_app.teams_destroy("team_1", request))

        payload = {"team_name": "Marketing", "password": "violet otter lantern quartz 92"}
        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", side_effect=ValueError("corrupt")),
        ):
            self.assert_status(503, self.admin_app.teams_destroy("team_1", request))

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(return_value=False)),
        ):
            self.assert_status(403, self.admin_app.teams_destroy("team_1", request))

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(return_value=True)),
            mock.patch.object(
                self.admin_app.team,
                "destroy_confirmed",
                return_value=self.admin_app.team.TeamResponse(200, {"deleted": True}),
            ) as confirmed,
        ):
            response = asyncio.run(self.admin_app.teams_destroy("team_1", request))
        self.assertEqual(response.status_code, 200)
        # Local Team confirms the current name itself (ADR-0088); Admin forwards the typed name.
        confirmed.assert_called_once_with("team_1", payload["team_name"])

    def test_chat_history_is_team_gated_and_never_cached(self) -> None:
        page = {
            "entries": [{"id": "a" * 32 + ":user", "kind": "message", "role": "user", "text": "Hello"}],
            "before": None,
        }
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(self.admin_app.chat_history, "page", return_value=page) as loaded,
        ):
            response = self.admin_app.team_chat_history("marketing", None)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(response.body), page)
        loaded.assert_called_once_with("marketing", before=None, routine=None)
        # A Routine's own history is read through the same gate, for exactly that Routine.
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(self.admin_app.chat_history, "page", return_value=page) as loaded,
        ):
            self.assertEqual(self.admin_app.team_chat_history("marketing", None, "a" * 32).status_code, 200)
        loaded.assert_called_once_with("marketing", before=None, routine="a" * 32)

        missing = self.admin_app.team.TeamResponse(404, {"detail": "Team not found"})
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value=missing),
            mock.patch.object(self.admin_app.chat_history, "page") as loaded,
        ):
            response = self.admin_app.team_chat_history("marketing", None)
        self.assertEqual(response.status_code, 404)
        loaded.assert_not_called()

    def test_team_lifecycle_cleanup_fails_loud_after_authoritative_success(self) -> None:
        deleted = self.admin_app.team.TeamResponse(200, {"deleted": True})
        failed = self.admin_app.team.TeamResponse(503, {"detail": "unavailable"})
        with mock.patch.object(self.admin_app.chat_history, "clear_team", return_value=3) as cleared:
            self.assertIs(self.admin_app._team_delete_with_history("marketing", lambda: deleted), deleted)
        cleared.assert_called_once_with("marketing")

        with mock.patch.object(self.admin_app.chat_history, "clear_team") as cleared:
            self.assertIs(self.admin_app._team_delete_with_history("marketing", lambda: failed), failed)
        cleared.assert_not_called()

        absent = self.admin_app.team.TeamResponse(404, {"detail": "Team not found"})
        with mock.patch.object(self.admin_app.chat_history, "clear_team", return_value=1) as cleared:
            response = self.admin_app._team_delete_with_history("marketing", lambda: absent)
        self.assertEqual(response, self.admin_app.team.TeamResponse(200, {"deleted": False}))
        cleared.assert_called_once_with("marketing")

        with mock.patch.object(
            self.admin_app.chat_history,
            "clear_team",
            side_effect=self.admin_app.chat_history.HistoryUnavailableError("full"),
        ):
            response = self.admin_app._team_delete_with_history("marketing", lambda: deleted)
        self.assertEqual(response.status, 503)

        with mock.patch.object(self.admin_app.chat_history, "clear_all", return_value=4) as cleared:
            self.assertIs(self.admin_app._space_reset_with_history(lambda: deleted), deleted)
        cleared.assert_called_once_with()

    def test_the_interface_registry_carries_names_but_never_the_canonical_english_summary(self) -> None:
        registry = self.admin_app.team.TeamResponse(
            200,
            {
                "assistants": [
                    {"id": "hello-pulse", "title": "Hello Pulse", "summary": "Says hello.", "actions": ["hello"]},
                    {"id": "salesnator", "title": "Salesnator", "summary": "Runs sales work.", "actions": ["sell"]},
                ],
                "trace_id": "a" * 32,
            },
        )
        with mock.patch.object(self.admin_app.team, "list_assistants", return_value=registry):
            shown = self.admin_app.team_summary.assistants_list()
        unavailable = self.admin_app.team.TeamResponse(503, {"detail": "Team is unavailable"})
        with mock.patch.object(self.admin_app.team, "list_assistants", return_value=unavailable):
            refused = self.admin_app.team_summary.assistants_list()
        malformed = self.admin_app.team.TeamResponse(200, {"assistants": [{"id": "hello-pulse"}]})
        with (
            mock.patch.object(self.admin_app.team, "list_assistants", return_value=malformed),
            self.assertRaises(self.admin_app.HTTPException) as invalid,
        ):
            self.admin_app.team_summary.assistants_list()

        self.assertEqual(
            json.loads(shown.body),
            {
                "assistants": [
                    {"id": "hello-pulse", "title": "Hello Pulse"},
                    {"id": "salesnator", "title": "Salesnator"},
                ]
            },
        )
        self.assertEqual((refused.status_code, json.loads(refused.body)), (503, {"detail": "Team is unavailable"}))
        self.assertEqual(invalid.exception.status_code, 502)

    def test_thin_team_assistant_and_file_routes_preserve_the_team_response(self) -> None:
        response = self.admin_app.team.TeamResponse(200, {"ok": True})
        synchronous = (
            (self.admin_app.team_inference.team_inference_status, self.admin_app.team, "get_inference", ("team_1",)),
            (self.admin_app.team_snapshots.local_assistants_list, self.admin_app.team, "list_local_assistants", ()),
            (
                self.admin_app.team_assistants_list,
                self.admin_app.team,
                "list_installed_assistants",
                ("team_1",),
            ),
            (
                self.admin_app.team_assistant_uninstall,
                self.admin_app.team,
                "uninstall_assistant",
                ("team_1", "assistant"),
            ),
            (self.admin_app.team_files.team_files_list, self.admin_app.team, "list_files", ("team_1",)),
            (self.admin_app.team_files.team_file_delete, self.admin_app.team, "delete_file", ("team_1", "f" * 32)),
        )
        for route, owner, name, arguments in synchronous:
            with self.subTest(route=route.__name__), mock.patch.object(owner, name, return_value=response):
                self.assertEqual(route(*arguments).status_code, 200)

        with (
            mock.patch.object(
                self.admin_app.team_http, "bounded_json_object", new=mock.AsyncMock(return_value={"model": "x"})
            ),
            mock.patch.object(self.admin_app.team, "configure_inference", return_value=response),
        ):
            configured = asyncio.run(self.admin_app.team_inference.team_inference_configure("team_1", mock.Mock()))
        self.assertEqual(configured.status_code, 200)

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value={"id": "a"})),
            mock.patch.object(self.admin_app.team, "install_assistant", return_value=response),
        ):
            installed = asyncio.run(self.admin_app.team_assistant_install("team_1", mock.Mock()))
        self.assertEqual(installed.status_code, 200)

        with (
            mock.patch.object(
                self.admin_app,
                "_bounded_json_object",
                new=mock.AsyncMock(return_value={"image_id": "x"}),
            ),
            mock.patch.object(self.admin_app.team, "install_local_assistant", return_value=response),
        ):
            installed = asyncio.run(self.admin_app.team_local_assistant_install("team_1", mock.Mock()))
        self.assertEqual(installed.status_code, 200)

        with (
            mock.patch.object(
                self.admin_app.team_files,
                "bounded_multipart_file",
                new=mock.AsyncMock(return_value=("file.txt", "text/plain", b"data")),
            ),
            mock.patch.object(self.admin_app.team, "upload_file", return_value=response),
        ):
            uploaded = asyncio.run(self.admin_app.team_files.team_file_upload("team_1", mock.Mock()))
        self.assertEqual(uploaded.status_code, 200)


if __name__ == "__main__":
    unittest.main()
