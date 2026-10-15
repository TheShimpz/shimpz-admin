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
    def test_real_uvicorn_negotiates_the_session_socket_and_closes_it_at_logout(self) -> None:
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

            uri = f"ws://127.0.0.1:{port}/api/session/ws"
            headers = {"Cookie": f"shimpz_admin={self.token}"}
            response = completed_turn("hello from the Team")
            empty = self.chat_socket._SyncSnapshot(
                "integration", self.transport.TeamResponse(200, {"team_id": "team_1", "status": "none"})
            )
            try:
                with self.assertRaises(InvalidStatus):
                    await websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        additional_headers=headers,
                    )
                with (
                    mock.patch.object(self.chat_socket.local, "turn", return_value=response),
                    mock.patch.object(self.chat_socket, "_sync_snapshot", return_value=empty),
                ):
                    async with websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        subprotocols=["shimpz.admin.v1"],
                        additional_headers=headers,
                    ) as websocket:
                        self.assertEqual(websocket.subprotocol, "shimpz.admin.v1")

                        async def received() -> dict:
                            # Past the session deadlines Admin tells the page as it opens.
                            while (frame := json.loads(await asyncio.wait_for(websocket.recv(), timeout=1)))[
                                "type"
                            ] == "session":
                                pass
                            return frame

                        await websocket.send(
                            '{"type":"call","id":"a","method":"chat.attach",'
                            '"params":{"team_id":"team_1","locale":"en"}}'
                        )
                        self.assertEqual(
                            await received(),
                            {"type": "result", "id": "a", "status": 200, "body": {"team_id": "team_1"}},
                        )
                        self.assertEqual(await received(), {"type": "sync-empty", "team_id": "team_1"})
                        await websocket.send(
                            '{"type":"chat","team_id":"team_1","message":"hello","files":[],"assistant_ids":[],'
                            '"locale":"en","timezone":"America/Sao_Paulo"}'
                        )
                        self.assertEqual(await received(), done_frame("hello from the Team"))
                        with self.assertRaises(TimeoutError):
                            await asyncio.wait_for(websocket.recv(), timeout=0.05)
                        # Logging out closes the real connection at once, as signed out.
                        await asyncio.to_thread(self.admin_app.state.revoke_sessions_for_logout, self.token)
                        with self.assertRaises(websockets.exceptions.ConnectionClosed) as closed:
                            await asyncio.wait_for(websocket.recv(), timeout=2)
                        self.assertEqual(closed.exception.rcvd.code, 4401)
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

    def test_chat_worker_preserves_the_request_supervisor_session(self) -> None:
        transport = self.admin_app.team.transport
        session = "v1:9999999999:0123456789abcdef:" + "a" * 64

        def bound_session() -> str | None:
            binding = transport._SUPERVISOR_SESSION.get()
            return None if binding is None else binding.value

        executor = self.chat_socket.BoundedThreadPoolExecutor(
            max_workers=1,
            max_outstanding=1,
            thread_name_prefix="chat-context-test",
        )
        try:
            with transport.supervisor_session(session, local_identity=self.admin_app.supervisor.new_identity()):
                future = self.chat_socket.submit_in_context(executor, bound_session)
            self.assertEqual(future.result(timeout=1), session)
            self.assertIsNone(bound_session())
        finally:
            executor.shutdown()
