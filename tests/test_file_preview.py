"""A Team file's preview through Admin: the session, Fetch Metadata, and the exact framing of what reaches the page."""

import asyncio
import base64
import contextlib
import json
import sys
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import ClassVar
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

import browser
from starlette.requests import Request
from team import bridge, transport
from team import files as team_files
from test_team_bridge_assistants import _LiveTeamCase, _probe_session
from test_team_transport_edges import _Response

PNG = b"\x89PNG\r\n\x1a\n" + b"preview"
JPEG = b"\xff\xd8\xff" + b"preview"
LIMIT = 512 * 1024
# Each file id answers one Team outcome: its status, headers, and body.
ANSWERS = {
    "a" * 32: (200, {"Content-Type": "image/png"}, PNG),
    "b" * 32: (200, {"Content-Type": "image/jpeg"}, JPEG),
    "c" * 32: (200, {"Content-Type": "image/webp"}, b"RIFF0000WEBP"),
    "d" * 32: (200, {"Content-Type": "image/png"}, b"\x89PNG\r\n\x1a\n" + b"0" * LIMIT),
    "e" * 32: (200, {"Content-Type": "image/png", "Content-Length": "40"}, PNG),
    "f" * 32: (200, {"Content-Type": "image/png"}, JPEG),
    "0" * 32: (404, {"Content-Type": "application/json"}, b'{"error":"file not found","code":"file-not-found"}'),
    "1" * 32: (
        503,
        {"Content-Type": "application/json"},
        b'{"error":"busy","code":"file-preview-busy","retry_after_ms":250,"trace_id":"' + b"9" * 32 + b'"}',
    ),
    "2" * 32: (503, {"Content-Type": "application/json"}, b'{"code":"file-preview-busy","retry_after_ms":60000}'),
    "3" * 32: (422, {"Content-Type": "application/json"}, b'{"error":"no preview","code":"file-preview-unsupported"}'),
    "4" * 32: (403, {"Content-Type": "application/json"}, b'{"error":"denied","code":"invalid-supervisor"}'),
    "5" * 32: (404, {"Content-Type": "application/json"}, b'{"error":"gone","code":"route-not-found"}'),
}
IMAGE_LOAD = {"sec-fetch-site": "same-origin", "sec-fetch-dest": "image"}
REFUSED_PAGES = {
    "cross_site": {"sec-fetch-site": "cross-site", "sec-fetch-dest": "image"},
    "same_site": {"sec-fetch-site": "same-site", "sec-fetch-dest": "image"},
    "navigation": {"sec-fetch-site": "same-origin", "sec-fetch-dest": "document"},
    "frame": {"sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe"},
    "no_destination": {"sec-fetch-site": "same-origin", "sec-fetch-dest": None},
    "no_browser_headers": {"sec-fetch-site": None, "sec-fetch-dest": None},
}


class _PreviewTeam(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.requests.append(
            {"path": self.path, "headers": {key.lower(): value for key, value in self.headers.items()}}
        )
        file_id = self.path.split("/")[5]
        status, headers, body = ANSWERS[file_id]
        self.send_response(status)
        for key, value in {"Content-Length": str(len(body)), **headers}.items():
            self.send_header(key, value)
        self.end_headers()
        # Admin refuses an oversized answer from its headers and closes before reading the body.
        with contextlib.suppress(ConnectionError):
            self.wfile.write(body)


class FilePreviewRouteTests(_LiveTeamCase):
    # The shared case's Team answers JSON only; this Team answers each file id as ANSWERS says.
    team_handler = _PreviewTeam

    def setUp(self):
        _PreviewTeam.requests = []
        super().setUp()

    def test_the_page_receives_exactly_the_framed_rendition_under_the_supervisor_session(self) -> None:
        document = self._run_asgi_probe("preview", Path(__file__).resolve())

        for file_id, media_type, body in (("a" * 32, "image/png", PNG), ("b" * 32, "image/jpeg", JPEG)):
            answer = document[f"image:{file_id}"]
            self.assertEqual(answer["status"], 200)
            self.assertEqual(base64.b64decode(answer["body"]), body)
            self.assertEqual(answer["headers"]["content-type"], media_type)
            self.assertEqual(answer["headers"]["content-length"], str(len(body)))
            self.assertEqual(answer["headers"]["cache-control"], "no-store")
            self.assertEqual(answer["headers"]["x-content-type-options"], "nosniff")
        # A script's read of the same rendition passes as an image load does.
        self.assertEqual(document["script"]["status"], 200)
        first = _PreviewTeam.requests[0]
        self.assertEqual(first["path"], f"/v1/teams/team_1/files/{'a' * 32}/preview")
        self.assertEqual(first["headers"]["accept"], "image/jpeg, image/png")
        self.assertEqual(first["headers"]["authorization"], "Bearer internal-test-bearer")
        # Team receives the request-bound Supervisor session assertion beside the bearer.
        self.assertTrue(first["headers"]["x-shimpz-supervisor"].startswith("Bearer "))

    def test_only_the_admin_page_with_a_session_reaches_team(self) -> None:
        document = self._run_asgi_probe("preview", Path(__file__).resolve())

        self.assertEqual(document["anonymous"], {"status": 401, "body": {"detail": "unauthenticated"}})
        for page in REFUSED_PAGES:
            with self.subTest(page=page):
                answer = document[f"page:{page}"]
                self.assertEqual(answer["status"], 403)
                self.assertEqual(answer["headers"]["cache-control"], "no-store")
        self.assertEqual(document["invalid_id"]["status"], 400)
        # Neither the refused pages, the anonymous load, nor the invalid id reached Team.
        requested = [request["path"].split("/")[5] for request in _PreviewTeam.requests]
        self.assertEqual(sorted(requested), sorted([*ANSWERS, "a" * 32]))

    def test_an_answer_beyond_the_framing_or_an_unknown_refusal_is_team_unavailable(self) -> None:
        document = self._run_asgi_probe("preview", Path(__file__).resolve())

        unavailable = {"detail": "team unavailable"}
        for file_id in ("c" * 32, "d" * 32, "e" * 32, "f" * 32, "4" * 32, "5" * 32):
            with self.subTest(file_id=file_id):
                self.assertEqual(document[f"image:{file_id}"]["status"], 502)
                self.assertEqual(json.loads(base64.b64decode(document[f"image:{file_id}"]["body"])), unavailable)
        closed = {
            "0" * 32: (404, {"detail": "file preview unavailable", "code": "file-not-found"}),
            "1" * 32: (503, {"detail": "file preview unavailable", "code": "file-preview-busy", "retry_after_ms": 250}),
            "2" * 32: (503, {"detail": "file preview unavailable", "code": "file-preview-busy"}),
            "3" * 32: (422, {"detail": "file preview unavailable", "code": "file-preview-unsupported"}),
        }
        for file_id, (status, body) in closed.items():
            with self.subTest(file_id=file_id):
                answer = document[f"image:{file_id}"]
                self.assertEqual((answer["status"], json.loads(base64.b64decode(answer["body"]))), (status, body))
                self.assertEqual(answer["headers"]["cache-control"], "no-store")


def _browser_request(headers: dict[str, str]) -> Request:
    raw = [(name.encode(), value.encode()) for name, value in headers.items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


class FilePreviewUnitTests(unittest.TestCase):
    """The same boundary in process, where branch coverage sees it."""

    def test_fetch_metadata_admits_only_the_pages_own_image_or_script_read(self) -> None:
        self.assertTrue(browser.same_origin_image(_browser_request(IMAGE_LOAD)))
        self.assertTrue(browser.same_origin_image(_browser_request({**IMAGE_LOAD, "sec-fetch-dest": "empty"})))
        for headers in (*REFUSED_PAGES.values(),):
            sent = {name: value for name, value in headers.items() if value is not None}
            self.assertFalse(browser.same_origin_image(_browser_request(sent)))

    def test_the_bridge_forwards_a_rendition_and_closes_every_refusal(self) -> None:
        rendition = transport.TeamAssetResponse(200, PNG, {}, "image/png")
        with mock.patch.object(bridge, "_call_preview", return_value=rendition) as call:
            self.assertIs(bridge.file_preview("team_1", "a" * 32), rendition)
        call.assert_called_once_with(f"/v1/teams/team_1/files/{'a' * 32}/preview")
        cases = (
            ((503, {"code": "file-preview-busy", "retry_after_ms": 250}), (503, "file-preview-busy", 250)),
            ((503, {"code": "file-preview-busy", "retry_after_ms": True}), (503, "file-preview-busy", None)),
            (
                (503, {"code": "file-preview-unavailable", "retry_after_ms": 250}),
                (503, "file-preview-unavailable", None),
            ),
            ((404, {"code": "team-not-found"}), (404, "team-not-found", None)),
            ((404, {"code": "file-preview-busy"}), (502, None, None)),
            ((401, {"code": "file-not-found"}), (502, None, None)),
        )
        for (status, error), (expected_status, code, retry) in cases:
            with (
                self.subTest(status=status, error=error),
                mock.patch.object(
                    bridge, "_call_preview", return_value=transport.TeamAssetResponse(status, None, error)
                ),
            ):
                answer = bridge.file_preview("team_1", "a" * 32)
            self.assertEqual((answer.status, answer.contents, answer.error.get("code")), (expected_status, None, code))
            self.assertEqual(answer.error.get("retry_after_ms"), retry)
        with mock.patch.object(bridge, "_call_preview") as call, self.assertRaises(bridge.TeamRequestError):
            bridge.file_preview("team_1", "../" + "a" * 29)
        call.assert_not_called()

    def test_the_route_answers_the_page_and_never_caches(self) -> None:
        rendition = transport.TeamAssetResponse(200, JPEG, {}, "image/jpeg")
        with mock.patch.object(team_files.team, "file_preview", return_value=rendition):
            answer = team_files.team_file_preview("team_1", "b" * 32, _browser_request(IMAGE_LOAD))
        self.assertEqual((answer.status_code, answer.body, answer.media_type), (200, JPEG, "image/jpeg"))
        self.assertEqual(answer.headers["cache-control"], "no-store")
        self.assertEqual(answer.headers["x-content-type-options"], "nosniff")
        refusal = transport.TeamAssetResponse(
            404, None, {"detail": "file preview unavailable", "code": "file-not-found"}
        )
        with mock.patch.object(team_files.team, "file_preview", return_value=refusal):
            answer = team_files.team_file_preview("team_1", "b" * 32, _browser_request(IMAGE_LOAD))
        self.assertEqual((answer.status_code, json.loads(answer.body)["code"]), (404, "file-not-found"))
        self.assertEqual(answer.headers["cache-control"], "no-store")
        with mock.patch.object(team_files.team, "file_preview") as preview:
            answer = team_files.team_file_preview("team_1", "b" * 32, _browser_request(REFUSED_PAGES["cross_site"]))
        self.assertEqual(answer.status_code, 403)
        preview.assert_not_called()

    def test_the_transport_admits_only_an_exactly_framed_signed_rendition(self) -> None:
        def answer(body: bytes, media_type: str = "image/png", length: int | None = None) -> _Response:
            headers = {"Content-Type": media_type, "Content-Length": str(len(body) if length is None else length)}
            return _Response(headers=headers, body=body)

        self.assertEqual(transport._decode_preview(answer(PNG)), transport.TeamAssetResponse(200, PNG, {}, "image/png"))
        self.assertEqual(transport._decode_preview(answer(JPEG, "image/jpeg")).media_type, "image/jpeg")
        self.assertEqual(transport._decode_preview(_Response(404, body=b'{"code":"file-not-found"}')).status, 404)
        for refused in (answer(JPEG), answer(b"RIFF", "image/webp"), answer(PNG, length=LIMIT + 1)):
            with self.subTest(headers=refused.headers), self.assertRaisesRegex(OSError, "invalid Team asset response"):
                transport._decode_preview(refused)
        with mock.patch.object(transport, "_request_asset", return_value="answer") as request:
            self.assertEqual(transport._call_preview("/v1/preview"), "answer")
        request.assert_called_once_with("GET", "/v1/preview", transport._PREVIEW_READING)


async def _raw_request(admin_app, path: str, *, token: str, headers: dict[str, str | None]) -> dict[str, object]:
    sent = [(name.encode(), value.encode()) for name, value in headers.items() if value is not None]
    if token:
        sent.append((b"cookie", f"{admin_app.COOKIE}={token}".encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.5"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": sent,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    messages = []

    async def send(message):
        messages.append(message)

    await asyncio.wait_for(admin_app.app(scope, receive, send), timeout=10)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return {
        "status": start["status"],
        "headers": {name.decode(): value.decode() for name, value in start["headers"]},
        "body": base64.b64encode(body).decode(),
    }


def _run_asgi_probe() -> None:
    admin_app, token = _probe_session()

    def path(file_id: str) -> str:
        return f"/api/teams/team_1/files/{file_id}/preview"

    async def scenario() -> dict[str, object]:
        results: dict[str, object] = {}
        for file_id in ANSWERS:
            results[f"image:{file_id}"] = await _raw_request(admin_app, path(file_id), token=token, headers=IMAGE_LOAD)
        results["script"] = await _raw_request(
            admin_app, path("a" * 32), token=token, headers={"sec-fetch-site": "same-origin", "sec-fetch-dest": "empty"}
        )
        for page, headers in REFUSED_PAGES.items():
            results[f"page:{page}"] = await _raw_request(admin_app, path("a" * 32), token=token, headers=headers)
        anonymous = await _raw_request(admin_app, path("a" * 32), token="", headers=IMAGE_LOAD)
        results["anonymous"] = {"status": anonymous["status"], "body": json.loads(base64.b64decode(anonymous["body"]))}
        results["invalid_id"] = await _raw_request(admin_app, path("A" * 32), token=token, headers=IMAGE_LOAD)
        return results

    print(json.dumps(asyncio.run(scenario())))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe()
    else:
        unittest.main()
