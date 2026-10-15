"""A Team file's download and a PDF page's preview through Admin (ADR-0093).

The session, Fetch Metadata, verification, the download's own policy through the whole middleware, and its bounded
slots.
"""

import asyncio
import base64
import contextlib
import gc
import hashlib
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
from fastapi import HTTPException
from starlette.requests import Request
from team import bridge, transport
from team import files as team_files
from test_file_preview import PNG, _raw_request
from test_team_bridge_assistants import _LiveTeamCase, _probe_session
from test_team_transport_edges import _Response

ORIGINAL = b"%PDF-1.7 <html><script>alert(1)</script></html>"


def _digest(body: bytes) -> str:
    return f"sha-256=:{base64.b64encode(hashlib.sha256(body).digest()).decode()}:"


def _content(body: bytes, **headers: str) -> tuple[int, dict[str, str], bytes]:
    return 200, {"Content-Type": "application/octet-stream", "Repr-Digest": _digest(body), **headers}, body


# Each file id answers one Team outcome for its content: its status, headers, and body.
CONTENT = {
    "a" * 32: _content(ORIGINAL),
    "b" * 32: _content(ORIGINAL, **{"Repr-Digest": _digest(b"other")}),
    "c" * 32: _content(ORIGINAL, **{"Content-Type": "application/pdf"}),
    "d" * 32: _content(ORIGINAL, **{"Content-Length": "26214401"}),
    "e" * 32: _content(ORIGINAL, **{"Repr-Digest": "sha-256=:not-base64:"}),
    "0" * 32: (404, {"Content-Type": "application/json"}, b'{"error":"file not found","code":"file-not-found"}'),
    "1" * 32: (
        503,
        {"Content-Type": "application/json"},
        b'{"error":"busy","code":"file-download-busy","retry_after_ms":250,"trace_id":"' + b"9" * 32 + b'"}',
    ),
    "4" * 32: (403, {"Content-Type": "application/json"}, b'{"error":"denied","code":"invalid-supervisor"}'),
}
# Each file id answers one Team outcome for its page 2.
PAGES = {
    "a" * 32: (200, {"Content-Type": "image/png", "X-Page-Count": "3"}, PNG),
    "b" * 32: (200, {"Content-Type": "image/png"}, PNG),
    "c" * 32: (200, {"Content-Type": "image/png", "X-Page-Count": "51"}, PNG),
}
DOWNLOAD = {"sec-fetch-site": "same-origin", "sec-fetch-dest": "document"}
SCRIPT_READ = {"sec-fetch-site": "same-origin", "sec-fetch-dest": "empty"}
REFUSED = {
    "cross_site": {"sec-fetch-site": "cross-site", "sec-fetch-dest": "document"},
    "image": {"sec-fetch-site": "same-origin", "sec-fetch-dest": "image"},
    "frame": {"sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe"},
    "no_destination": {"sec-fetch-site": "same-origin", "sec-fetch-dest": None},
    "no_browser_headers": {"sec-fetch-site": None, "sec-fetch-dest": None},
}


class _FileTeam(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, object]]] = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.requests.append(
            {"path": self.path, "headers": {key.lower(): value for key, value in self.headers.items()}}
        )
        file_id = self.path.split("/")[5]
        status, headers, body = (CONTENT if self.path.endswith("/content") else PAGES)[file_id]
        self.send_response(status)
        for key, value in {"Content-Length": str(len(body)), **headers}.items():
            self.send_header(key, value)
        self.end_headers()
        with contextlib.suppress(ConnectionError):
            self.wfile.write(body)


class FileDownloadRouteTests(_LiveTeamCase):
    team_handler = _FileTeam

    def setUp(self):
        _FileTeam.requests = []
        super().setUp()

    def test_the_page_downloads_exactly_the_verified_original_as_a_sandboxed_attachment(self) -> None:
        document = self._run_asgi_probe("download", Path(__file__).resolve())

        for name in ("download", "script"):
            with self.subTest(read=name):
                answer = document[name]
                self.assertEqual(answer["status"], 200)
                self.assertEqual(base64.b64decode(answer["body"]), ORIGINAL)
                headers = answer["headers"]
                self.assertEqual(headers["content-type"], "application/octet-stream")
                self.assertEqual(headers["content-disposition"], "attachment")
                # The download's own policy survives Admin's page policy on the way out.
                self.assertEqual(headers["content-security-policy"], "sandbox; default-src 'none'")
                self.assertEqual(headers["cross-origin-resource-policy"], "same-origin")
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertEqual(headers["x-content-type-options"], "nosniff")
        first = _FileTeam.requests[0]
        self.assertEqual(first["path"], f"/v1/teams/team_1/files/{'a' * 32}/content")
        self.assertEqual(first["headers"]["accept"], "application/octet-stream")
        self.assertTrue(first["headers"]["x-shimpz-supervisor"].startswith("Bearer "))

    def test_only_the_admin_page_with_a_session_reaches_team(self) -> None:
        document = self._run_asgi_probe("download", Path(__file__).resolve())

        self.assertEqual(document["anonymous"], 401)
        for page in REFUSED:
            with self.subTest(page=page):
                self.assertEqual(document[f"page:{page}"]["status"], 403)
        self.assertEqual(document["invalid_id"]["status"], 400)
        requested = [request["path"] for request in _FileTeam.requests if request["path"].endswith("/content")]
        self.assertEqual(len(requested), len(CONTENT) + 1)

    def test_a_misframed_or_unverified_original_never_reaches_the_page(self) -> None:
        document = self._run_asgi_probe("download", Path(__file__).resolve())

        for file_id in ("b" * 32, "c" * 32, "d" * 32, "e" * 32, "4" * 32):
            with self.subTest(file_id=file_id):
                answer = document[f"content:{file_id}"]
                self.assertEqual(answer["status"], 502)
                self.assertEqual(json.loads(base64.b64decode(answer["body"])), {"detail": "team unavailable"})
        closed = {
            "0" * 32: (404, {"detail": "file download unavailable", "code": "file-not-found"}),
            "1" * 32: (
                503,
                {"detail": "file download unavailable", "code": "file-download-busy", "retry_after_ms": 250},
            ),
        }
        for file_id, (status, body) in closed.items():
            with self.subTest(file_id=file_id):
                answer = document[f"content:{file_id}"]
                self.assertEqual((answer["status"], json.loads(base64.b64decode(answer["body"]))), (status, body))

    def test_a_pdf_page_reaches_the_page_with_its_page_count(self) -> None:
        document = self._run_asgi_probe("download", Path(__file__).resolve())

        answer = document["page:" + "a" * 32]
        self.assertEqual(answer["status"], 200)
        self.assertEqual(base64.b64decode(answer["body"]), PNG)
        self.assertEqual(answer["headers"]["x-page-count"], "3")
        self.assertEqual(answer["headers"]["cache-control"], "no-store")
        for file_id in ("b" * 32, "c" * 32):
            with self.subTest(file_id=file_id):
                self.assertEqual(document["page:" + file_id]["status"], 502)
        self.assertEqual(document["page:invalid"]["status"], 400)
        pages = [request["path"] for request in _FileTeam.requests if request["path"].endswith("/preview")]
        self.assertEqual(pages[0], f"/v1/teams/team_1/files/{'a' * 32}/pages/2/preview")
        self.assertEqual(len(pages), len(PAGES))


def _browser_request(headers: dict[str, str]) -> Request:
    raw = [(name.encode(), value.encode()) for name, value in headers.items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


def _sent(headers: dict[str, str | None]) -> dict[str, str]:
    return {name: value for name, value in headers.items() if value is not None}


class FileDownloadUnitTests(unittest.TestCase):
    """The same boundary in process, where branch coverage sees it."""

    def tearDown(self) -> None:
        gc.collect()
        # Every test leaves every download slot free again.
        held = [team_files._DOWNLOADS.acquire(blocking=False) for _ in range(team_files.MAX_DOWNLOADS)]
        for taken in held:
            if taken:
                team_files._DOWNLOADS.release()
        self.assertEqual(held, [True] * team_files.MAX_DOWNLOADS)

    def test_fetch_metadata_admits_only_the_pages_own_download_or_script_read(self) -> None:
        self.assertTrue(browser.same_origin_fetch(_browser_request(DOWNLOAD), browser.DOWNLOAD_DESTINATIONS))
        self.assertTrue(browser.same_origin_fetch(_browser_request(SCRIPT_READ), browser.DOWNLOAD_DESTINATIONS))
        for headers in REFUSED.values():
            self.assertFalse(browser.same_origin_fetch(_browser_request(_sent(headers)), browser.DOWNLOAD_DESTINATIONS))

    def test_the_transport_admits_only_an_exactly_framed_verified_original(self) -> None:
        def answer(body: bytes, **headers: str) -> _Response:
            sent = {"Content-Type": "application/octet-stream", "Content-Length": str(len(body))}
            sent["Repr-Digest"] = _digest(body)
            return _Response(headers={**sent, **headers}, body=body)

        self.assertEqual(
            transport._decode_content(answer(ORIGINAL)),
            transport.TeamAssetResponse(200, ORIGINAL, {}, "application/octet-stream"),
        )
        self.assertEqual(transport._decode_content(_Response(404, body=b'{"code":"file-not-found"}')).status, 404)
        refused = (
            answer(ORIGINAL, **{"Content-Type": "text/html"}),
            answer(ORIGINAL, **{"Content-Length": "x"}),
            answer(ORIGINAL, **{"Content-Length": "0"}),
            answer(ORIGINAL, **{"Content-Length": str(len(ORIGINAL) + 1)}),
            answer(ORIGINAL, **{"Repr-Digest": _digest(b"other")}),
            answer(ORIGINAL, **{"Repr-Digest": "md5=:AAAA:"}),
            _Response(headers={"Content-Type": "application/octet-stream", "Content-Length": "3"}, body=b"abc"),
        )
        for response in refused:
            with self.subTest(headers=response.headers), self.assertRaisesRegex(OSError, "file content"):
                transport._decode_content(response)
        with mock.patch.object(transport, "_request_asset", return_value="answer") as request:
            self.assertEqual(transport.call_content("/v1/content"), "answer")
            self.assertEqual(transport.call_page_preview("/v1/page"), "answer")
        self.assertEqual(
            request.call_args_list,
            [
                mock.call("GET", "/v1/content", transport._CONTENT_READING),
                mock.call("GET", "/v1/page", transport._PAGE_PREVIEW_READING),
            ],
        )

    def test_the_transport_admits_a_page_only_with_its_page_count(self) -> None:
        def answer(**headers: str) -> _Response:
            return _Response(
                headers={"Content-Type": "image/png", "Content-Length": str(len(PNG)), **headers}, body=PNG
            )

        self.assertEqual(transport._decode_page_preview(answer(**{"X-Page-Count": "3"})).page_count, 3)
        self.assertEqual(transport._decode_page_preview(_Response(404, body=b'{"code":"file-not-found"}')).status, 404)
        for count in (None, "0", "51", "03", "x"):
            headers = {} if count is None else {"X-Page-Count": count}
            with self.subTest(count=count), self.assertRaisesRegex(OSError, "invalid Team asset response"):
                transport._decode_page_preview(answer(**headers))

    def test_the_bridge_forwards_bytes_and_closes_every_refusal(self) -> None:
        original = transport.TeamAssetResponse(200, ORIGINAL, {}, "application/octet-stream")
        with mock.patch.object(transport, "call_content", return_value=original) as call:
            self.assertIs(bridge.file_content("team_1", "a" * 32), original)
        call.assert_called_once_with(f"/v1/teams/team_1/files/{'a' * 32}/content")
        page = transport.TeamAssetResponse(200, PNG, {}, "image/png", 3)
        with mock.patch.object(transport, "call_page_preview", return_value=page) as call:
            self.assertIs(bridge.file_page_preview("team_1", "a" * 32, "2"), page)
        call.assert_called_once_with(f"/v1/teams/team_1/files/{'a' * 32}/pages/2/preview")
        cases = (
            ((503, {"code": "file-download-busy", "retry_after_ms": 250}), (503, "file-download-busy", 250)),
            ((404, {"code": "file-not-found"}), (404, "file-not-found", None)),
            ((422, {"code": "file-preview-unsupported"}), (502, None, None)),
        )
        for (status, error), (expected_status, code, retry) in cases:
            with (
                self.subTest(status=status, error=error),
                mock.patch.object(
                    transport, "call_content", return_value=transport.TeamAssetResponse(status, None, error)
                ),
            ):
                answer = bridge.file_content("team_1", "a" * 32)
            self.assertEqual((answer.status, answer.error.get("code")), (expected_status, code))
            self.assertEqual(answer.error.get("retry_after_ms"), retry)
        for invalid in ("0", "51", "01", 2, None):
            with (
                self.subTest(page=invalid),
                mock.patch.object(transport, "call_page_preview") as call,
                self.assertRaises(transport.TeamRequestError),
            ):
                bridge.file_page_preview("team_1", "a" * 32, invalid)
            call.assert_not_called()

    def test_the_page_preview_route_answers_its_page_count_and_refuses_other_pages(self) -> None:
        page = transport.TeamAssetResponse(200, PNG, {}, "image/png", 3)
        image = _browser_request({"sec-fetch-site": "same-origin", "sec-fetch-dest": "image"})
        with mock.patch.object(team_files.team, "file_page_preview", return_value=page):
            answer = team_files.team_file_page_preview("team_1", "a" * 32, "2", image)
        self.assertEqual((answer.status_code, answer.body), (200, PNG))
        self.assertEqual(answer.headers["x-page-count"], "3")
        with mock.patch.object(team_files.team, "file_page_preview") as preview:
            answer = team_files.team_file_page_preview(
                "team_1", "a" * 32, "2", _browser_request(_sent(REFUSED["frame"]))
            )
        self.assertEqual(answer.status_code, 403)
        preview.assert_not_called()

    def _download(self, request: Request, outcome: object) -> object:
        side_effect = outcome if isinstance(outcome, BaseException) else None
        with mock.patch.object(
            team_files.team, "file_content", return_value=None if side_effect else outcome, side_effect=side_effect
        ):
            return asyncio.run(team_files.team_file_download("team_1", "a" * 32, request))

    def _send(self, response: object, send: object | None = None) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []

        async def sent(message: dict[str, object]) -> None:
            messages.append(message)

        async def receive() -> dict[str, object]:
            return {"type": "http.disconnect"}

        asyncio.run(response({"type": "http", "method": "GET"}, receive, send or sent))
        return messages

    def test_a_download_holds_its_slot_until_its_response_ends(self) -> None:
        original = transport.TeamAssetResponse(200, ORIGINAL, {}, "application/octet-stream")
        response = self._download(_browser_request(DOWNLOAD), original)
        self.assertIsInstance(response, team_files._Download)
        self.assertEqual(response.headers["content-security-policy"], "sandbox; default-src 'none'")
        # The other slot is still free; a third download beyond both is busy until the first ends.
        second = self._download(_browser_request(DOWNLOAD), original)
        busy = self._download(_browser_request(DOWNLOAD), original)
        self.assertEqual((busy.status_code, json.loads(busy.body)["code"]), (503, "file-download-busy"))
        self.assertEqual(busy.headers["cache-control"], "no-store")
        messages = self._send(response)
        self.assertEqual(b"".join(message.get("body", b"") for message in messages), ORIGINAL)
        third = self._download(_browser_request(DOWNLOAD), original)
        self.assertIsInstance(third, team_files._Download)
        self._send(second)
        self._send(third)

    def test_every_outcome_but_a_download_releases_its_slot_at_once(self) -> None:
        refusal = transport.TeamAssetResponse(
            404, None, {"detail": "file download unavailable", "code": "file-not-found"}
        )
        for _ in range(team_files.MAX_DOWNLOADS + 1):
            answer = self._download(_browser_request(DOWNLOAD), refusal)
            self.assertEqual(answer.status_code, 404)
            self.assertEqual(answer.headers["cache-control"], "no-store")
            with self.assertRaises(HTTPException):
                self._download(_browser_request(DOWNLOAD), transport.TeamRequestError("file id is invalid"))
            with self.assertRaises(OSError):
                self._download(_browser_request(DOWNLOAD), OSError("team failed"))
        refused = self._download(_browser_request(_sent(REFUSED["image"])), refusal)
        self.assertEqual(refused.status_code, 403)

    def test_a_download_that_fails_or_outlives_its_deadline_releases_its_slot(self) -> None:
        original = transport.TeamAssetResponse(200, ORIGINAL, {}, "application/octet-stream")

        async def broken(_message: dict[str, object]) -> None:
            raise OSError("the browser went away")

        with self.assertRaises(OSError):
            self._send(self._download(_browser_request(DOWNLOAD), original), broken)

        async def stalled(_message: dict[str, object]) -> None:
            await asyncio.sleep(5)

        with mock.patch.object(team_files, "DOWNLOAD_SEND_SECONDS", 0.01):
            self._send(self._download(_browser_request(DOWNLOAD), original), stalled)

    def test_a_download_response_that_is_never_sent_gives_its_slot_back_once_dropped(self) -> None:
        for _ in range(team_files.MAX_DOWNLOADS + 1):
            self.assertTrue(team_files._DOWNLOADS.acquire(blocking=False))
            slot = team_files._Slot()
            response = team_files._Download(ORIGINAL, slot)
            del response
            gc.collect()
            self.assertFalse(slot.held)
            # A second release of the same slot frees nothing more.
            slot.release()


def _run_asgi_probe() -> None:
    admin_app, token = _probe_session()
    files = "/api/teams/team_1/files"

    async def scenario() -> dict[str, object]:
        results: dict[str, object] = {}
        download = f"{files}/{'a' * 32}/download"
        results["download"] = await _raw_request(admin_app, download, token=token, headers=DOWNLOAD)
        results["script"] = await _raw_request(admin_app, download, token=token, headers=SCRIPT_READ)
        for file_id in CONTENT:
            if file_id != "a" * 32:
                path = f"{files}/{file_id}/download"
                results[f"content:{file_id}"] = await _raw_request(admin_app, path, token=token, headers=DOWNLOAD)
        for page, headers in REFUSED.items():
            results[f"page:{page}"] = await _raw_request(admin_app, download, token=token, headers=headers)
        anonymous = await _raw_request(admin_app, download, token="", headers=DOWNLOAD)
        results["anonymous"] = anonymous["status"]
        results["invalid_id"] = await _raw_request(
            admin_app, f"{files}/{'A' * 32}/download", token=token, headers=DOWNLOAD
        )
        image = {"sec-fetch-site": "same-origin", "sec-fetch-dest": "image"}
        for file_id in PAGES:
            path = f"{files}/{file_id}/pages/2/preview"
            results[f"page:{file_id}"] = await _raw_request(admin_app, path, token=token, headers=image)
        invalid_page = f"{files}/{'a' * 32}/pages/51/preview"
        results["page:invalid"] = await _raw_request(admin_app, invalid_page, token=token, headers=image)
        return results

    print(json.dumps(asyncio.run(scenario())))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--asgi-probe":
        _run_asgi_probe()
    else:
        unittest.main()
