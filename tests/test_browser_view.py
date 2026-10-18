"""A Browser task's screen through Admin (ADR-0117): the view, and the screen's WebSocket relayed to Team.

Admission, the bounded streams, Team's refusals, both directions, and the session's end.
"""

import asyncio
import contextlib
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from protocol.socket.v1 import frames
from session import methods as session_methods
from session import registry
from team import bridge, transport
from team import browser_view as team_browser_view
from tests.chat_socket_case import ChatWebSocketCase
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

VIEW = "a" * 32
PATH = f"/api/teams/team_1/browser/views/{VIEW}/stream"


class Page:
    """An in-memory ASGI client of the stream route, as Admin's own page opens it."""

    def __init__(self, application, *, token="", origin="http://localhost:7777", protocols=("binary",), path=PATH):
        headers = [(b"host", b"localhost:7777")]
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        if protocols:
            headers.append((b"sec-websocket-protocol", ", ".join(protocols).encode()))
        if token:
            headers.append((b"cookie", f"shimpz_admin={token}".encode()))
        self.scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.5"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 7777),
            "subprotocols": list(protocols),
            "state": {},
            "extensions": {},
        }
        self.application = application
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.outgoing: asyncio.Queue = asyncio.Queue()
        self.task = None

    async def start(self) -> dict:
        await self.incoming.put({"type": "websocket.connect"})
        self.task = asyncio.create_task(self.application(self.scope, self.incoming.get, self.outgoing.put))
        return await self.next()

    async def next(self) -> dict:
        return await asyncio.wait_for(self.outgoing.get(), 5)

    async def send(self, data: bytes) -> None:
        await self.incoming.put({"type": "websocket.receive", "bytes": data})

    async def send_text(self, text: str) -> None:
        await self.incoming.put({"type": "websocket.receive", "text": text})

    async def close(self) -> None:
        await self.incoming.put({"type": "websocket.disconnect", "code": 1000})
        if self.task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.task, 5)


class FakeTeam:
    """Team's stream route: it checks the exact path and the Supervisor's assertion, then plays the display."""

    def __init__(self, *, refuse: int | None = None, greeting: bytes = b"RFB 003.008\n", text: bool = False):
        self.refuse, self.greeting, self.text = refuse, greeting, text
        self.requests: list[tuple[str, Headers]] = []
        self.received: list[bytes] = []

    def process_request(self, connection, request):
        self.requests.append((request.path, request.headers))
        if self.refuse is not None:
            return Response(self.refuse, "Refused", Headers([("Content-Length", "0")]), b"")
        return None

    async def handler(self, connection):
        await connection.send("text frame" if self.text else self.greeting)
        with contextlib.suppress(Exception):
            async for message in connection:
                self.received.append(message)
                await connection.send(b"echo:" + message)

    @contextlib.asynccontextmanager
    async def running(self):
        async with serve(
            self.handler, "127.0.0.1", 0, process_request=self.process_request, subprotocols=["binary"]
        ) as server:
            port = server.sockets[0].getsockname()[1]

            def connection(path):
                return (
                    socket.create_connection(("127.0.0.1", port)),
                    {"Authorization": "Bearer test-token"},
                    (f"ws://127.0.0.1:{port}{path}"),
                )

            with mock.patch.object(transport, "stream_connection", side_effect=connection):
                yield


class BrowserStreamTests(ChatWebSocketCase):
    def page(self, **options) -> Page:
        return Page(self.admin_app.app, token=options.pop("token", self.token), **options)

    def test_the_page_and_team_exchange_binary_through_admin_until_team_ends(self) -> None:
        team = FakeTeam()

        async def scenario():
            async with team.running():
                page = self.page()
                accepted = await page.start()
                self.assertEqual(accepted, {"type": "websocket.accept", "subprotocol": "binary", "headers": []})
                self.assertEqual((await page.next())["bytes"], b"RFB 003.008\n")
                await page.send(b"\x01")
                self.assertEqual((await page.next())["bytes"], b"echo:\x01")
                await page.close()
            return team

        asyncio.run(scenario())
        [(path, headers)] = team.requests
        self.assertEqual(path, f"/v1/teams/team_1/browser/views/{VIEW}/stream")
        self.assertEqual(headers["Sec-WebSocket-Protocol"], "binary")
        self.assertNotIn("Sec-WebSocket-Extensions", headers)
        self.assertEqual(team.received, [b"\x01"])

    def test_only_admins_own_page_with_a_session_and_the_binary_subprotocol_is_admitted(self) -> None:
        async def refused(**options) -> dict:
            async with FakeTeam().running():
                page = self.page(**options)
                return await page.start()

        cases = (
            ({"token": ""}, registry.SIGNED_OUT),
            ({"origin": "https://elsewhere.example"}, 4403),
            ({"origin": None}, 4403),
            ({"protocols": ("shimpz.admin.v1",)}, 4406),
            ({"path": "/api/teams/team_1/browser/views/notaview/stream"}, team_browser_view.ENDED),
        )
        for options, code in cases:
            with self.subTest(options=options):
                self.assertEqual(asyncio.run(refused(**options))["code"], code)

    def test_two_streams_at_most_run_at_once(self) -> None:
        async def scenario():
            held = [team_browser_view._STREAMS.acquire(blocking=False) for _ in range(team_browser_view.MAX_STREAMS)]
            try:
                async with FakeTeam().running():
                    return held, await self.page().start()
            finally:
                for taken in held:
                    if taken:
                        team_browser_view._STREAMS.release()

        held, answer = asyncio.run(scenario())
        self.assertEqual(held, [True] * team_browser_view.MAX_STREAMS)
        self.assertEqual(answer["code"], team_browser_view.BUSY)

    def test_teams_refusals_reach_the_page_as_closed_codes(self) -> None:
        async def scenario(team: FakeTeam) -> dict:
            async with team.running():
                page = self.page()
                self.assertEqual((await page.start())["type"], "websocket.accept")
                return await page.next()

        for status, code in ((404, team_browser_view.ENDED), (503, team_browser_view.UNAVAILABLE), (500, 1013)):
            with self.subTest(status=status):
                self.assertEqual(asyncio.run(scenario(FakeTeam(refuse=status)))["code"], code)

        async def unreachable() -> dict:
            with mock.patch.object(transport, "stream_connection", side_effect=OSError("down")):
                page = self.page()
                await page.start()
                return await page.next()

        self.assertEqual(asyncio.run(unreachable())["code"], team_browser_view.UNAVAILABLE)

    def test_a_text_message_on_either_side_ends_the_stream(self) -> None:
        async def from_team() -> dict:
            async with FakeTeam(text=True).running():
                page = self.page()
                await page.start()
                return await page.next()

        self.assertEqual(asyncio.run(from_team())["code"], team_browser_view.ENDED)

        async def from_page() -> dict:
            async with FakeTeam().running():
                page = self.page()
                await page.start()
                await page.next()
                await page.send_text("not binary")
                return await page.next()

        self.assertEqual(asyncio.run(from_page())["code"], team_browser_view.ENDED)

    def test_the_session_ending_ends_the_stream(self) -> None:
        answers = iter(["active", "active", "invalid"])

        async def status(*_args) -> str:
            return next(answers, "invalid")

        async def scenario() -> dict:
            with (
                mock.patch.object(team_browser_view, "SESSION_CHECK_SECONDS", 0.05),
                mock.patch.object(registry, "session_status", side_effect=status),
            ):
                async with FakeTeam().running():
                    page = self.page()
                    await page.start()
                    await page.next()
                    return await page.next()

        self.assertEqual(asyncio.run(scenario())["code"], registry.SIGNED_OUT)

    def test_origin_authority_that_fails_refuses_the_stream_or_ends_it(self) -> None:
        async def refused() -> dict:
            with mock.patch.object(self.admin_app, "_allowed_browser_origins", side_effect=RuntimeError("down")):
                async with FakeTeam().running():
                    return await self.page().start()

        self.assertEqual(asyncio.run(refused())["code"], team_browser_view.UNAVAILABLE)
        origins = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        answers = iter([origins, origins, RuntimeError("down")])

        def allowed():
            answer = next(answers, RuntimeError("down"))
            if isinstance(answer, Exception):
                raise answer
            return answer

        async def ended() -> dict:
            with (
                mock.patch.object(team_browser_view, "SESSION_CHECK_SECONDS", 0.05),
                mock.patch.object(self.admin_app, "_allowed_browser_origins", side_effect=allowed),
            ):
                async with FakeTeam().running():
                    page = self.page()
                    await page.start()
                    await page.next()
                    return await page.next()

        self.assertEqual(asyncio.run(ended())["code"], registry.SIGNED_OUT)

    def test_a_team_that_answers_without_the_binary_subprotocol_is_unavailable(self) -> None:
        team = FakeTeam()

        @contextlib.asynccontextmanager
        async def without_subprotocol():
            async with serve(team.handler, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]

                def connection(path):
                    return socket.create_connection(("127.0.0.1", port)), {}, f"ws://127.0.0.1:{port}{path}"

                with mock.patch.object(transport, "stream_connection", side_effect=connection):
                    yield

        async def scenario() -> dict:
            async with without_subprotocol():
                page = self.page()
                await page.start()
                return await page.next()

        self.assertEqual(asyncio.run(scenario())["code"], team_browser_view.UNAVAILABLE)

    def test_a_team_that_drops_the_handshake_is_unavailable(self) -> None:
        async def scenario() -> dict:
            async def drop(_reader, writer):
                writer.close()

            server = await asyncio.start_server(drop, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]

            def connection(path):
                return socket.create_connection(("127.0.0.1", port)), {}, f"ws://127.0.0.1:{port}{path}"

            try:
                with mock.patch.object(transport, "stream_connection", side_effect=connection):
                    page = self.page()
                    await page.start()
                    return await page.next()
            finally:
                server.close()

        self.assertEqual(asyncio.run(scenario())["code"], team_browser_view.UNAVAILABLE)


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

    def test_the_socket_opens_a_view_with_the_team_alone(self) -> None:
        self.assertEqual(frames.METHODS["browser.view"], (frozenset({"team_id"}), frozenset()))
        self.assertIn("browser.view", session_methods.METHODS)

    def test_a_stream_reaches_team_with_the_supervisors_assertion_for_its_exact_path(self) -> None:
        with (
            mock.patch.object(transport, "_endpoint", return_value=("127.0.0.1", 7077)),
            mock.patch.object(transport, "_request_headers", return_value={"Authorization": "x"}) as signed,
            mock.patch.object(transport.socket, "create_connection", return_value="connection") as connected,
        ):
            self.assertEqual(
                transport.stream_connection("/v1/teams/team_1/browser/views/a/stream"),
                ("connection", {"Authorization": "x"}, "ws://127.0.0.1:7077/v1/teams/team_1/browser/views/a/stream"),
            )
        self.assertEqual(signed.call_args.args, ("GET", "/v1/teams/team_1/browser/views/a/stream", None))
        connected.assert_called_once_with(("127.0.0.1", 7077), timeout=transport.STREAM_CONNECT_SECONDS)


if __name__ == "__main__":
    unittest.main()
