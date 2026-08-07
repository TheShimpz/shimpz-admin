"""Bounded multipart parsing and upload cleanup contracts for the Admin application."""

from __future__ import annotations

import asyncio
import importlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.datastructures import Headers, UploadFile
from starlette.formparsers import MultiPartException
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def _request(
    headers: list[tuple[bytes, bytes]],
    chunks: list[bytes] | None = None,
) -> Request:
    body_chunks = list(chunks or [b""])
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": "/api/teams/team_1/files",
        "raw_path": b"/api/teams/team_1/files",
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("192.0.2.30", 1234),
        "server": ("admin.example.test", 443),
    }
    index = 0

    async def receive():
        nonlocal index
        if index >= len(body_chunks):
            return {"type": "http.request", "body": b"", "more_body": False}
        body = body_chunks[index]
        index += 1
        return {"type": "http.request", "body": body, "more_body": index < len(body_chunks)}

    return Request(scope, receive)


class _Parser:
    def __init__(self, stream, *, result=None, error: Exception | None = None, consume: bool = False) -> None:
        self.stream = stream
        self.result = result
        self.error = error
        self.consume = consume

    async def parse(self):
        if self.consume:
            async for _chunk in self.stream:
                pass
        if self.error is not None:
            raise self.error
        return self.result


def _parser_factory(*, result=None, error: Exception | None = None, consume: bool = False):
    def create(_headers, stream, **_limits):
        return _Parser(stream, result=result, error=error, consume=consume)

    return create


def _form(items: list[tuple[str, object]]):
    form = mock.Mock()
    form.multi_items.return_value = items
    form.close = mock.AsyncMock()
    return form


def _upload(content: bytes, *, filename: str = "file.txt", content_type: str = "text/plain") -> UploadFile:
    return UploadFile(
        io.BytesIO(content),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


class AppMultipartEdgeTests(unittest.TestCase):
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

    def assert_status(self, expected: int, awaitable) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            asyncio.run(awaitable)
        self.assertEqual(raised.exception.status_code, expected)

    @staticmethod
    def multipart_headers(*extra: tuple[bytes, bytes]) -> list[tuple[bytes, bytes]]:
        return [(b"content-type", b"multipart/form-data; boundary=test"), *extra]

    def test_media_type_and_declared_length_are_exact_and_bounded(self) -> None:
        self.assert_status(
            415,
            self.admin_app._bounded_multipart_file(_request([(b"content-type", b"application/json")])),
        )
        self.assert_status(
            400,
            self.admin_app._bounded_multipart_file(
                _request(self.multipart_headers((b"content-length", b"1"), (b"content-length", b"1")))
            ),
        )
        self.assert_status(
            400,
            self.admin_app._bounded_multipart_file(
                _request(self.multipart_headers((b"content-length", b"invalid")))
            ),
        )
        self.assert_status(
            413,
            self.admin_app._bounded_multipart_file(
                _request(
                    self.multipart_headers(
                        (b"content-length", str(self.admin_app.MAX_MULTIPART_BODY_BYTES + 1).encode())
                    )
                )
            ),
        )

    def test_streaming_limit_and_parser_failure_are_mapped_without_leaking_parser_errors(self) -> None:
        with (
            mock.patch.object(self.admin_app, "MAX_MULTIPART_BODY_BYTES", 3),
            mock.patch.object(
                self.admin_app,
                "MultiPartParser",
                side_effect=_parser_factory(consume=True),
            ),
        ):
            self.assert_status(
                413,
                self.admin_app._bounded_multipart_file(
                    _request(self.multipart_headers(), chunks=[b"four"])
                ),
            )

        with mock.patch.object(
            self.admin_app,
            "MultiPartParser",
            side_effect=_parser_factory(error=MultiPartException("invalid")),
        ):
            self.assert_status(
                400,
                self.admin_app._bounded_multipart_file(_request(self.multipart_headers())),
            )

    def test_form_shape_and_canonical_metadata_failures_always_close_the_form(self) -> None:
        invalid_form = _form([])
        with mock.patch.object(
            self.admin_app,
            "MultiPartParser",
            side_effect=_parser_factory(result=invalid_form),
        ):
            self.assert_status(
                400,
                self.admin_app._bounded_multipart_file(_request(self.multipart_headers())),
            )
        invalid_form.close.assert_awaited_once_with()

        upload = _upload(b"data")
        invalid_metadata_form = _form([("file", upload)])
        with (
            mock.patch.object(
                self.admin_app,
                "MultiPartParser",
                side_effect=_parser_factory(result=invalid_metadata_form),
            ),
            mock.patch.object(
                self.admin_app.team,
                "canonical_filename",
                side_effect=self.admin_app.team.TeamRequestError("invalid filename"),
            ),
        ):
            self.assert_status(
                400,
                self.admin_app._bounded_multipart_file(_request(self.multipart_headers())),
            )
        invalid_metadata_form.close.assert_awaited_once_with()

    def test_empty_oversized_and_valid_file_content_are_distinguished(self) -> None:
        empty_form = _form([("file", _upload(b""))])
        with mock.patch.object(
            self.admin_app,
            "MultiPartParser",
            side_effect=_parser_factory(result=empty_form),
        ):
            self.assert_status(
                400,
                self.admin_app._bounded_multipart_file(_request(self.multipart_headers())),
            )
        empty_form.close.assert_awaited_once_with()

        oversized_form = _form([("file", _upload(b"two"))])
        with (
            mock.patch.object(self.admin_app.team, "MAX_FILE_UPLOAD_BYTES", 2),
            mock.patch.object(
                self.admin_app,
                "MultiPartParser",
                side_effect=_parser_factory(result=oversized_form),
            ),
        ):
            self.assert_status(
                413,
                self.admin_app._bounded_multipart_file(_request(self.multipart_headers())),
            )
        oversized_form.close.assert_awaited_once_with()

        valid_form = _form([("file", _upload(b"data"))])
        with mock.patch.object(
            self.admin_app,
            "MultiPartParser",
            side_effect=_parser_factory(result=valid_form, consume=True),
        ):
            result = asyncio.run(
                self.admin_app._bounded_multipart_file(
                    _request(self.multipart_headers((b"content-length", b"1")), chunks=[b"x"])
                )
            )
        self.assertEqual(result, ("file.txt", "text/plain", b"data"))
        valid_form.close.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
