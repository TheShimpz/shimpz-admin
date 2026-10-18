"""A Browser task's screen through Admin: the view opened over the socket and its frames over HTTP (ADR-0117, M2 Watch).

Team's exact framing, the closed refusals, Fetch Metadata, and the bounded frame slots, in process.
"""

import asyncio
import gc
import http.client
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from fastapi import HTTPException
from protocol.socket.v1 import frames
from session import methods as session_methods
from team import bridge, transport
from team import browser_view as team_browser_view
from test_file_preview import browser_request
from test_team_transport_edges import _Response

from protocol.http.v1 import browser_view as view_contract

VIEW = "a" * 32
PNG = view_contract.PNG_SIGNATURE + b"frame"
IMAGE_READ = {"sec-fetch-site": "same-origin", "sec-fetch-dest": "empty"}


def _frame(body: bytes = PNG, **headers: str) -> _Response:
    sent = {"Content-Type": "image/png", "Content-Length": str(len(body)), view_contract.FRAME_HEADER: "7"}
    return _Response(headers={**sent, **headers}, body=body)


class BrowserViewTransportTests(unittest.TestCase):
    def test_only_an_exactly_framed_png_or_no_content_passes(self) -> None:
        self.assertEqual(
            transport._decode_browser_frame(_frame()), transport.TeamAssetResponse(200, PNG, {}, "image/png", frame=7)
        )
        self.assertEqual(
            transport._decode_browser_frame(_Response(204, headers={}, body=b"")),
            transport.TeamAssetResponse(204, None, {}),
        )
        refusal = transport._decode_browser_frame(_Response(404, body=b'{"code":"browser-not-running"}'))
        self.assertEqual((refusal.status, refusal.error), (404, {"code": "browser-not-running"}))
        for response in (
            _Response(204, headers={}, body=b"x"),
            _frame(**{view_contract.FRAME_HEADER: "0"}),
            _frame(**{view_contract.FRAME_HEADER: "07"}),
            _frame(**{"Content-Type": "image/jpeg"}),
            _frame(b"GIF89a-frame"),
            _Response(headers={"Content-Type": "image/png", view_contract.FRAME_HEADER: "7"}, body=PNG),
        ):
            with self.subTest(headers=response.headers), self.assertRaises(OSError):
                transport._decode_browser_frame(response)
        missing = _frame()
        del missing.headers[view_contract.FRAME_HEADER]
        with self.assertRaises(OSError):
            transport._decode_browser_frame(missing)

    def test_a_frame_is_asked_for_as_png_with_no_body(self) -> None:
        answer = transport.TeamAssetResponse(204, None, {})
        with mock.patch.object(transport, "_request_asset", return_value=answer) as asked:
            self.assertIs(transport.call_browser_frame("/v1/teams/team_1/browser/views/x/frames/0"), answer)
        path, reading = asked.call_args.args
        self.assertEqual((path, reading.accept), ("/v1/teams/team_1/browser/views/x/frames/0", "image/png"))


class _Wire:
    """A socket holding one raw HTTP answer, for the real `http.client` parser."""

    def __init__(self, raw: bytes) -> None:
        self.raw = raw

    def makefile(self, _mode: str) -> io.BytesIO:
        return io.BytesIO(self.raw)


def _parsed(raw: bytes) -> http.client.HTTPResponse:
    response = http.client.HTTPResponse(_Wire(raw), method="GET")
    response.begin()
    return response


class BrowserViewWireTests(unittest.TestCase):
    def test_a_no_content_answer_admits_no_body_framing_on_the_wire(self) -> None:
        empty = _parsed(b"HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\n\r\n")
        self.assertEqual(transport._decode_browser_frame(empty), transport.TeamAssetResponse(204, None, {}))
        zero = _parsed(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        self.assertEqual(transport._decode_browser_frame(zero).status, 204)
        for raw in (
            b"HTTP/1.1 204 No Content\r\nContent-Length: 1\r\n\r\nx",
            b"HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n",
        ):
            with self.subTest(raw=raw), self.assertRaises(OSError):
                transport._decode_browser_frame(_parsed(raw))
        body = PNG
        framed = _parsed(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nX-Shimpz-Browser-Frame: 4\r\n\r\n"
            + body
        )
        self.assertEqual(
            transport._decode_browser_frame(framed), transport.TeamAssetResponse(200, PNG, {}, "image/png", frame=4)
        )


class BrowserViewBridgeTests(unittest.TestCase):
    def test_opening_passes_on_exactly_a_view_or_a_closed_refusal(self) -> None:
        cases = (
            (transport.TeamResponse(200, {"view_id": VIEW}), (200, {"view_id": VIEW})),
            (
                transport.TeamResponse(404, {"error": "x", "code": "browser-not-running", "trace_id": "t"}),
                (404, {"detail": "browser view unavailable", "code": "browser-not-running"}),
            ),
            (transport.TeamResponse(200, {"view_id": VIEW.upper()}), (502, {"detail": "team unavailable"})),
            (transport.TeamResponse(409, {"code": "browser-not-running"}), (502, {"detail": "team unavailable"})),
        )
        for answer, expected in cases:
            with self.subTest(expected=expected), mock.patch.object(transport, "call", return_value=answer) as call:
                response = bridge.open_browser_view("team_1")
                self.assertEqual((response.status, response.body), expected)
                call.assert_called_once_with("POST", "/v1/teams/team_1/browser/view")

    def test_a_frame_request_names_its_view_and_cursor_exactly(self) -> None:
        frame = transport.TeamAssetResponse(200, PNG, {}, "image/png", frame=3)
        with mock.patch.object(transport, "call_browser_frame", return_value=frame) as call:
            self.assertIs(bridge.browser_view_frame("team_1", VIEW, "2"), frame)
        call.assert_called_once_with(f"/v1/teams/team_1/browser/views/{VIEW}/frames/2")
        nothing = transport.TeamAssetResponse(204, None, {})
        with mock.patch.object(transport, "call_browser_frame", return_value=nothing):
            self.assertIs(bridge.browser_view_frame("team_1", VIEW, "0"), nothing)
        busy = transport.TeamAssetResponse(503, None, {"code": "browser-view-busy", "retry_after_ms": 250})
        with mock.patch.object(transport, "call_browser_frame", return_value=busy):
            refused = bridge.browser_view_frame("team_1", VIEW, "0")
        self.assertEqual(
            (refused.status, refused.error), (503, {"detail": "browser view unavailable", "code": "browser-view-busy"})
        )
        for view_id, after in ((VIEW.upper(), "0"), (7, "0"), (VIEW, "01"), (VIEW, "-1")):
            with self.subTest(view_id=view_id, after=after), self.assertRaises(transport.TeamRequestError):
                bridge.browser_view_frame("team_1", view_id, after)

    def test_the_socket_opens_a_view_with_the_team_alone(self) -> None:
        self.assertEqual(frames.METHODS["browser.view"], (frozenset({"team_id"}), frozenset()))
        self.assertIn("browser.view", session_methods.METHODS)


class BrowserFrameRouteTests(unittest.TestCase):
    def tearDown(self) -> None:
        gc.collect()
        held = [team_browser_view._VIEWS.acquire(blocking=False) for _ in range(team_browser_view.MAX_VIEWS)]
        for taken in held:
            if taken:
                team_browser_view._VIEWS.release()
        self.assertEqual(held, [True] * team_browser_view.MAX_VIEWS)

    def _frame(self, outcome: object, headers: dict[str, str] = IMAGE_READ) -> object:
        side_effect = outcome if isinstance(outcome, BaseException) else None
        with mock.patch.object(
            team_browser_view.team,
            "browser_view_frame",
            return_value=None if side_effect else outcome,
            side_effect=side_effect,
        ):
            return asyncio.run(team_browser_view.browser_frame("team_1", VIEW, "0", browser_request(headers)))

    def _send(self, response: object, send: object | None = None) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []

        async def sent(message: dict[str, object]) -> None:
            messages.append(message)

        async def receive() -> dict[str, object]:
            return {"type": "http.disconnect"}

        asyncio.run(response({"type": "http", "method": "GET"}, receive, send or sent))
        return messages

    def test_a_frame_holds_its_slot_until_its_response_ends(self) -> None:
        frame = transport.TeamAssetResponse(200, PNG, {}, "image/png", frame=3)
        first = self._frame(frame)
        self.assertEqual(first.headers[view_contract.FRAME_HEADER], "3")
        self.assertEqual(first.headers["cache-control"], "no-store")
        self.assertEqual(first.media_type, "image/png")
        second = self._frame(frame)
        busy = self._frame(frame)
        self.assertEqual((busy.status_code, json.loads(busy.body)["code"]), (503, "browser-view-busy"))
        self.assertEqual(b"".join(message.get("body", b"") for message in self._send(first)), PNG)
        self._send(second)

    def test_every_other_outcome_releases_its_slot_at_once(self) -> None:
        refusal = transport.TeamAssetResponse(404, None, {"detail": "browser view unavailable", "code": "x"})
        for _ in range(team_browser_view.MAX_VIEWS + 1):
            self.assertEqual(self._frame(transport.TeamAssetResponse(204, None, {})).status_code, 204)
            answer = self._frame(refusal)
            self.assertEqual((answer.status_code, answer.headers["cache-control"]), (404, "no-store"))
            with self.assertRaises(HTTPException):
                self._frame(transport.TeamRequestError("after must be a frame number"))
        for headers in (
            {"sec-fetch-site": "cross-site", "sec-fetch-dest": "image"},
            {"sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe"},
            {},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self._frame(refusal, headers).status_code, 403)

    def test_a_frame_that_fails_or_outlives_its_deadline_releases_its_slot(self) -> None:
        frame = transport.TeamAssetResponse(200, PNG, {}, "image/png", frame=1)

        async def stalled(_message: dict[str, object]) -> None:
            await asyncio.sleep(5)

        with mock.patch.object(team_browser_view, "VIEW_SEND_SECONDS", 0.01):
            self._send(self._frame(frame), stalled)
        for _ in range(team_browser_view.MAX_VIEWS + 1):
            slot = team_browser_view._Slot()
            self.assertTrue(team_browser_view._VIEWS.acquire(blocking=False))
            response = team_browser_view._Frame(PNG, 1, slot)
            del response
            gc.collect()
            self.assertFalse(slot.held)
            slot.release()


if __name__ == "__main__":
    unittest.main()
