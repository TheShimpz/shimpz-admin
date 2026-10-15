"""Bounded JSON, Team lifecycle, and thin Team operation edges for the Admin application."""

import asyncio
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import app_import
from history import store as history_store
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from http_request import http_request, json_request, remote


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
    cookies = {"shimpz_admin": cookie} if cookie else None
    return json_request("/api/test", payload, peer=remote("192.0.2.20"), cookies=cookies, browser=())


class AppRouteEdgeTests(app_import.RouteStatusAssertions):
    @classmethod
    def setUpClass(cls) -> None:
        root = app_import.temporary_root(cls)
        cls.admin_app = app_import.load_app(root)
        app_import.replace_for_class(cls, cls.admin_app.state, "STORE_PATH", root / "admin.json")
        app_import.replace_for_class(cls, history_store, "STORE_PATH", root / "chat-history.sqlite3")
        cls.team_names = importlib.import_module("team.names")
        cls.team_summary = importlib.import_module("team.summary")
        cls.team_inference = importlib.import_module("team.inference")
        cls.team_snapshots = importlib.import_module("team.snapshots")

    def delete_with_history(self, team_id: str, answer):
        with mock.patch.object(self.admin_app.team, "destroy_confirmed", return_value=answer):
            return self.team_names._deleted_with_history(team_id, "Marketing")

    def assert_sync_status(self, expected: int, action) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            action()
        self.assertEqual(raised.exception.status_code, expected)

    def test_a_team_request_admin_refused_is_a_bad_request(self) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            self.admin_app.team_http.response(
                lambda: (_ for _ in ()).throw(self.admin_app.team.TeamRequestError("bad"))
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_the_platform_release_read_is_a_read_only_local_projection(self) -> None:
        self.platform_release = importlib.import_module("space.release")
        status = {
            "release": f"ghcr.io/theshimpz/shimpz-local-release@sha256:{'a' * 64}",
            "ordinal": 42,
            "checked_at": 1_786_229_541,
            "outcome": "current",
        }
        with mock.patch.object(self.platform_release, "read_status", return_value=status):
            self.assertEqual(
                self.platform_release.status_response(),
                {**status, "checked_at": "2026-08-08T22:52:21Z"},
            )
        with mock.patch.object(
            self.platform_release,
            "read_status",
            side_effect=self.platform_release.PlatformReleaseUnavailableError,
        ):
            self.assert_sync_status(503, self.platform_release.status_response)

    def test_bounded_json_rejects_media_length_stream_and_document_violations(self) -> None:
        self.assert_status(415, self.admin_app.team_http.bounded_json_object(_request(body=b"{}")))
        self.assert_status(
            400,
            self.admin_app.team_http.bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json"), (b"content-length", b"x")])
            ),
        )
        self.assert_status(
            413,
            self.admin_app.team_http.bounded_json_object(
                _request(
                    body=b"{}",
                    headers=[(b"content-type", b"application/json"), (b"content-length", b"3")],
                ),
                max_bytes=2,
            ),
        )
        self.assert_status(
            413,
            self.admin_app.team_http.bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json")]),
                max_bytes=1,
            ),
        )
        for body in (b"{", b'{"key":1,"key":2}', b'{"key":NaN}', b'{"key":[1e999]}'):
            with self.subTest(body=body):
                self.assert_status(
                    400,
                    self.admin_app.team_http.bounded_json_object(
                        _request(body=body, headers=[(b"content-type", b"application/json")])
                    ),
                )
        self.assert_status(
            400,
            self.admin_app.team_http.bounded_json_object(
                _request(body=b"[]", headers=[(b"content-type", b"application/json")])
            ),
        )

    def test_team_creation_validates_shape_and_logs_only_successful_creation(self) -> None:
        invalid = (
            ({"name": "Marketing"}, 400),
            ({"team_name": 1}, 400),
            ({"team_name": "  "}, 400),
        )
        for payload, expected in invalid:
            with self.subTest(payload=payload):
                self.assert_sync_status(expected, lambda payload=payload: self.team_names.create(payload))

        with mock.patch.object(self.admin_app.team, "to_team_id", return_value=""):
            self.assert_sync_status(400, lambda: self.team_names.create({"team_name": "!!!"}))

        with (
            mock.patch.object(
                self.admin_app.team,
                "create",
                return_value=self.admin_app.team.TeamResponse(201, {"team_id": "marketing"}),
            ),
            mock.patch.object(self.admin_app.log, "info") as logged,
        ):
            response = self.team_names.create({"team_name": " Marketing "})
        self.assertEqual(response.status_code, 201)
        logged.assert_called_once_with("team created: %s", "marketing")

        with mock.patch.object(
            self.admin_app.team,
            "create",
            return_value=self.admin_app.team.TeamResponse(409, {"error": "exists"}),
        ):
            self.assertEqual(self.team_names.create({"team_name": "Marketing"}).status_code, 409)

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
            mock.patch.object(history_store, "clear_team", return_value=2) as cleared,
        ):
            self.assertEqual(self.team_names.create({"team_name": "Marketing"}).status_code, 201)
            self.assertEqual(self.team_names.create({"team_name": "Marketing"}).status_code, 200)
        cleared.assert_called_once_with("marketing")

    def test_the_history_read_is_team_gated_and_never_cached(self) -> None:
        page = {
            "entries": [{"id": "a" * 32 + ":user", "kind": "message", "role": "user", "text": "Hello"}],
            "before": None,
        }
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(history_store, "page", return_value=page) as loaded,
        ):
            response = self.admin_app.chat_history_http.page("marketing", None)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(response.body), page)
        loaded.assert_called_once_with("marketing", before=None, routine=None)
        # A Routine's own history is read through the same gate, for exactly that Routine.
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value="Marketing"),
            mock.patch.object(history_store, "page", return_value=page) as loaded,
        ):
            self.assertEqual(self.admin_app.chat_history_http.page("marketing", None, "a" * 32).status_code, 200)
        loaded.assert_called_once_with("marketing", before=None, routine="a" * 32)

        missing = self.admin_app.team.TeamResponse(404, {"detail": "Team not found"})
        with (
            mock.patch.object(self.admin_app.team, "resolve_team_name", return_value=missing),
            mock.patch.object(history_store, "page") as loaded,
        ):
            response = self.admin_app.chat_history_http.page("marketing", None)
        self.assertEqual(response.status_code, 404)
        loaded.assert_not_called()

    def test_team_lifecycle_cleanup_fails_loud_after_authoritative_success(self) -> None:
        deleted = self.admin_app.team.TeamResponse(200, {"deleted": True})
        failed = self.admin_app.team.TeamResponse(503, {"detail": "unavailable"})
        with mock.patch.object(history_store, "clear_team", return_value=3) as cleared:
            self.assertIs(self.delete_with_history("marketing", deleted), deleted)
        cleared.assert_called_once_with("marketing")

        with mock.patch.object(history_store, "clear_team") as cleared:
            self.assertIs(self.delete_with_history("marketing", failed), failed)
        cleared.assert_not_called()

        absent = self.admin_app.team.TeamResponse(404, {"detail": "Team not found"})
        with mock.patch.object(history_store, "clear_team", return_value=1) as cleared:
            response = self.delete_with_history("marketing", absent)
        self.assertEqual(response, self.admin_app.team.TeamResponse(200, {"deleted": False}))
        cleared.assert_called_once_with("marketing")

        with mock.patch.object(
            history_store,
            "clear_team",
            side_effect=history_store.HistoryUnavailableError("full"),
        ):
            response = self.delete_with_history("marketing", deleted)
        self.assertEqual(response.status, 503)

        with mock.patch.object(history_store, "clear_all", return_value=4) as cleared:
            self.assertIs(self.admin_app._space_reset_with_history(lambda: deleted), deleted)
        cleared.assert_called_once_with()

    def test_the_interface_registry_carries_each_assistants_name(self) -> None:
        registry = self.admin_app.team.TeamResponse(
            200,
            {
                "assistants": [
                    {"id": "hello-pulse", "title": "Hello Pulse"},
                    {"id": "salesnator", "title": "Salesnator"},
                ],
                "trace_id": "a" * 32,
            },
        )
        with mock.patch.object(self.admin_app.team, "list_assistants", return_value=registry):
            shown = self.team_summary.assistants_list()
        unavailable = self.admin_app.team.TeamResponse(503, {"detail": "Team is unavailable"})
        with mock.patch.object(self.admin_app.team, "list_assistants", return_value=unavailable):
            refused = self.team_summary.assistants_list()
        malformed = self.admin_app.team.TeamResponse(200, {"assistants": [{"id": "hello-pulse"}]})
        with (
            mock.patch.object(self.admin_app.team, "list_assistants", return_value=malformed),
            self.assertRaises(self.admin_app.HTTPException) as invalid,
        ):
            self.team_summary.assistants_list()

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

    def test_thin_team_operations_preserve_the_team_response(self) -> None:
        response = self.admin_app.team.TeamResponse(200, {"ok": True})
        operations = (
            (self.team_inference.status, "get_inference", ("team_1",)),
            (self.team_inference.configure, "configure_inference", ("team_1", {"model": "x"})),
            (self.team_snapshots.local_assistants_list, "list_local_assistants", ()),
            (self.admin_app.team_files.team_files_list, "list_files", ("team_1",)),
            (self.admin_app.team_files.team_file_delete, "delete_file", ("team_1", "f" * 32)),
        )
        for operation, name, arguments in operations:
            with (
                self.subTest(operation=operation.__name__),
                mock.patch.object(self.admin_app.team, name, return_value=response),
            ):
                self.assertEqual(operation(*arguments).status_code, 200)

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
