"""Real-network and bounded-worker contracts for Admin chat WebSockets."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import uvicorn
import websockets
from mfa_helper import configure_supervisor
from websockets.exceptions import InvalidStatus

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


class ChatWebSocketRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tempdir.cleanup)
        cls.root = Path(cls.tempdir.name)
        with mock.patch.dict(
            os.environ,
            {
                "SHIMPZ_REPO": str(cls.root),
                "SHIMPZ_ADMIN_STORE": str(cls.root / "admin.json"),
                "SHIMPZ_ADMIN_PROFILE": "local",
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            cls.admin_app = importlib.import_module("app")
        cls.chat_socket = importlib.import_module("chat.socket")
        previous_store = cls.admin_app.state.STORE_PATH
        previous_origins = cls.chat_socket.STATIC_ORIGINS
        cls.admin_app.state.STORE_PATH = cls.root / "admin.json"
        cls.chat_socket.STATIC_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.state, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.chat_socket, "STATIC_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.state.STORE_PATH.unlink(missing_ok=True)
        secret = configure_supervisor(self.admin_app.state, "violet otter lantern quartz 92")
        self.token = self.admin_app.auth.issue_session(secret, "totp")

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
            response = self.chat_socket.local.PublicResponse(
                200,
                {"team_id": "team_1", "team_name": "Marketing", "reply": "hello from the Team"},
            )
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
                        subprotocols=["shimpz.chat.v6"],
                        additional_headers=headers,
                    ) as websocket:
                        self.assertEqual(websocket.subprotocol, "shimpz.chat.v6")
                        await websocket.send('{"type":"chat","message":"hello","files":[],"assistant_ids":[]}')
                        self.assertEqual(
                            json.loads(await asyncio.wait_for(websocket.recv(), timeout=1)),
                            {
                                "type": "done",
                                "team_id": "team_1",
                                "team_name": "Marketing",
                                "reply": "hello from the Team",
                            },
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
