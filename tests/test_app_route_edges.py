"""Bounded JSON and thin Team route edges for the Admin HTTP application."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


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
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": request_headers,
        "client": ("192.0.2.20", 1234),
        "server": ("admin.example.test", 443),
    }
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


def _json_request(payload: object, *, cookie: str = "") -> Request:
    body = json.dumps(payload).encode()
    return _request(
        body=body,
        headers=[
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
        cookie=cookie,
    )


class AppRouteEdgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(root),
                "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
            },
        ):
            sys.modules.pop("app", None)
            cls.admin_app = importlib.import_module("app")

    def assert_async_status(self, expected: int, awaitable) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            asyncio.run(awaitable)
        self.assertEqual(raised.exception.status_code, expected)

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

    def test_bounded_json_rejects_media_length_stream_and_document_violations(self) -> None:
        self.assert_async_status(415, self.admin_app._bounded_json_object(_request(body=b"{}")))
        self.assert_async_status(
            400,
            self.admin_app._bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json"), (b"content-length", b"x")])
            ),
        )
        self.assert_async_status(
            413,
            self.admin_app._bounded_json_object(
                _request(
                    body=b"{}",
                    headers=[(b"content-type", b"application/json"), (b"content-length", b"3")],
                ),
                max_bytes=2,
            ),
        )
        self.assert_async_status(
            413,
            self.admin_app._bounded_json_object(
                _request(body=b"{}", headers=[(b"content-type", b"application/json")]),
                max_bytes=1,
            ),
        )
        for body in (b"{", b'{"key":1,"key":2}'):
            with self.subTest(body=body):
                self.assert_async_status(
                    400,
                    self.admin_app._bounded_json_object(
                        _request(body=body, headers=[(b"content-type", b"application/json")])
                    ),
                )
        self.assert_async_status(
            400,
            self.admin_app._bounded_json_object(
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

    def test_local_team_deletion_validates_confirmation_and_authority_failures(self) -> None:
        request = _json_request({}, cookie="token")
        cases = (({"team_name": "Marketing"}, 400), ({"team_name": 1, "password": "secret"}, 400))
        for payload, expected in cases:
            with (
                self.subTest(payload=payload),
                mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            ):
                self.assert_async_status(expected, self.admin_app.teams_destroy("team_1", request))

        with mock.patch.object(
            self.admin_app,
            "_bounded_json_object",
            new=mock.AsyncMock(return_value={"team_name": "Marketing", "password": ""}),
        ):
            self.assert_async_status(400, self.admin_app.teams_destroy("team_1", request))

        payload = {"team_name": "Marketing", "password": "correct horse battery staple"}
        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", side_effect=ValueError("corrupt")),
        ):
            self.assert_async_status(503, self.admin_app.teams_destroy("team_1", request))

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(return_value=False)),
        ):
            self.assert_async_status(403, self.admin_app.teams_destroy("team_1", request))

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app.state, "get", return_value={}),
            mock.patch.object(self.admin_app.asyncio, "to_thread", new=mock.AsyncMock(return_value=True)),
            mock.patch.object(
                self.admin_app.team,
                "destroy",
                return_value=self.admin_app.team.TeamResponse(200, {"deleted": True}),
            ),
        ):
            response = asyncio.run(self.admin_app.teams_destroy("team_1", request))
        self.assertEqual(response.status_code, 200)

    def test_hosted_team_deletion_maps_session_and_sudo_statuses(self) -> None:
        request = _json_request({}, cookie="token")
        payload = {"team_name": "Marketing", "password": "correct horse battery staple"}
        with (
            mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
            mock.patch.object(self.admin_app, "_session_evidence", new=mock.AsyncMock(return_value=None)),
        ):
            self.assert_async_status(401, self.admin_app.teams_destroy("team_1", request))

        statuses = ((401, 403), (429, 429), (503, 503))
        for upstream, expected in statuses:
            with (
                self.subTest(upstream=upstream),
                mock.patch.object(self.admin_app, "ADMIN_PROFILE", "hosted"),
                mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value=payload)),
                mock.patch.object(
                    self.admin_app,
                    "_session_evidence",
                    new=mock.AsyncMock(return_value={"active": True}),
                ),
                mock.patch.object(
                    self.admin_app.account_identity,
                    "run_bounded",
                    new=mock.AsyncMock(
                        return_value=self.admin_app.account_identity.AccountResponse(upstream, {"status": "result"})
                    ),
                ),
            ):
                self.assert_async_status(expected, self.admin_app.teams_destroy("team_1", request))

    def test_thin_team_assistant_and_file_routes_preserve_the_team_response(self) -> None:
        response = self.admin_app.team.TeamResponse(200, {"ok": True})
        synchronous = (
            (self.admin_app.teams_list, self.admin_app.team, "list_teams", ()),
            (self.admin_app.team_inference_status, self.admin_app.team, "get_inference", ("team_1",)),
            (self.admin_app.assistants_list, self.admin_app.team, "list_assistants", ()),
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
            (self.admin_app.team_files_list, self.admin_app.team, "list_files", ("team_1",)),
            (self.admin_app.team_file_delete, self.admin_app.team, "delete_file", ("team_1", "f" * 32)),
        )
        for route, owner, name, arguments in synchronous:
            with self.subTest(route=route.__name__), mock.patch.object(owner, name, return_value=response):
                self.assertEqual(route(*arguments).status_code, 200)

        with (
            mock.patch.object(self.admin_app, "_bounded_json_object", new=mock.AsyncMock(return_value={"model": "x"})),
            mock.patch.object(self.admin_app.team, "configure_inference", return_value=response),
        ):
            configured = asyncio.run(self.admin_app.team_inference_configure("team_1", mock.Mock()))
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
                "_bounded_multipart_file",
                new=mock.AsyncMock(return_value=("file.txt", "text/plain", b"data")),
            ),
            mock.patch.object(self.admin_app.team, "upload_file", return_value=response),
        ):
            uploaded = asyncio.run(self.admin_app.team_file_upload("team_1", mock.Mock()))
        self.assertEqual(uploaded.status_code, 200)


if __name__ == "__main__":
    unittest.main()
