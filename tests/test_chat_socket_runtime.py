"""Real-network and bounded-worker contracts for Admin chat WebSockets."""

import asyncio
import json
import socket
import threading
from unittest import mock

import uvicorn
import websockets
from tests.chat_socket_case import ChatWebSocketCase
from tests.chat_socket_fixtures import completed_turn, done_frame
from websockets.exceptions import InvalidStatus


class ChatWebSocketRuntimeTests(ChatWebSocketCase):
    def test_real_uvicorn_negotiates_v3_and_delivers_one_public_terminal(self) -> None:
        async def scenario() -> None:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(128)
            port = listener.getsockname()[1]
            server = uvicorn.Server(
                uvicorn.Config(
                    self.admin_app.app,
                    host="127.0.0.1",
                    port=port,
                    lifespan="off",
                    log_level="critical",
                )
            )
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            deadline = asyncio.get_running_loop().time() + 2
            while not server.started:
                if server_task.done():
                    await server_task
                if asyncio.get_running_loop().time() >= deadline:
                    self.fail("Uvicorn did not start")
                await asyncio.sleep(0.01)

            uri = f"ws://127.0.0.1:{port}/api/teams/team_1/chat/ws"
            headers = {"Cookie": f"shimpz_admin={self.token}"}
            response = completed_turn("hello from the Team")
            try:
                with self.assertRaises(InvalidStatus):
                    await websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        additional_headers=headers,
                    )
                with mock.patch.object(self.chat_socket.local, "turn", return_value=response):
                    async with websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        subprotocols=["shimpz.chat.v7"],
                        additional_headers=headers,
                    ) as websocket:
                        self.assertEqual(websocket.subprotocol, "shimpz.chat.v7")
                        await websocket.send(
                            '{"type":"chat","message":"hello","files":[],"assistant_ids":[],'
                            '"locale":"en","timezone":"America/Sao_Paulo",'
                            '"request":null}'
                        )
                        # The seal of the admitted send comes first; the browser keeps it to resend this send.
                        sent = json.loads(await asyncio.wait_for(websocket.recv(), timeout=1))
                        self.assertEqual((sent["type"], len(sent["request"].split("."))), ("sent", 3))
                        self.assertEqual(
                            json.loads(await asyncio.wait_for(websocket.recv(), timeout=1)),
                            done_frame("hello from the Team"),
                        )
                        with self.assertRaises(TimeoutError):
                            await asyncio.wait_for(websocket.recv(), timeout=0.05)
            finally:
                server.should_exit = True
                await asyncio.wait_for(server_task, timeout=3)
                listener.close()

        asyncio.run(scenario())

    def test_worker_queue_rejects_instead_of_growing(self) -> None:
        executor = self.chat_socket.BoundedThreadPoolExecutor(
            max_workers=1,
            max_outstanding=1,
            thread_name_prefix="chat-test",
        )
        release = threading.Event()
        future = executor.submit(release.wait)
        try:
            with self.assertRaises(self.chat_socket.ExecutorSaturatedError):
                executor.submit(lambda: None)
        finally:
            release.set()
            future.result(timeout=1)
            executor.shutdown()

    def test_chat_worker_preserves_the_request_account_session(self) -> None:
        transport = self.admin_app.team.transport
        account_session = "a1:" + ("a" * 32) + ":2209600:" + ("b" * 64) + ":" + ("c" * 64)
        executor = self.chat_socket.BoundedThreadPoolExecutor(
            max_workers=1,
            max_outstanding=1,
            thread_name_prefix="chat-context-test",
        )
        try:
            with transport.supervisor_session(account_session, account=True):
                future = self.chat_socket.submit_in_context(executor, transport._account_session)
            self.assertEqual(future.result(timeout=1), account_session)
            self.assertEqual(transport._account_session(), "")
        finally:
            executor.shutdown()
