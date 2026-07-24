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
                "SHIMPZ_ADMIN_ALLOWED_ORIGINS": "http://localhost:7777,http://127.0.0.1:7777",
            },
        ):
            cls.admin_app = importlib.import_module("app")
        cls.chat_ws = importlib.import_module("chat_ws")
        previous_store = cls.admin_app.adminstore.STORE_PATH
        previous_origins = cls.chat_ws.ALLOWED_ORIGINS
        cls.admin_app.adminstore.STORE_PATH = cls.root / "admin.json"
        cls.chat_ws.ALLOWED_ORIGINS = frozenset({"http://localhost:7777", "http://127.0.0.1:7777"})
        cls.addClassCleanup(setattr, cls.admin_app.adminstore, "STORE_PATH", previous_store)
        cls.addClassCleanup(setattr, cls.chat_ws, "ALLOWED_ORIGINS", previous_origins)

    def setUp(self) -> None:
        self.admin_app.adminstore.STORE_PATH.unlink(missing_ok=True)
        self.admin_app.adminstore.set_password("correct horse battery staple")
        store = self.admin_app.adminstore.get()
        self.token = self.admin_app.auth.issue_session(store["session_secret"])

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
            response = self.chat_ws.localchat.PublicResponse(
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
                with mock.patch.object(self.chat_ws.localchat, "turn", return_value=response):
                    async with websockets.connect(
                        uri,
                        origin="http://localhost:7777",
                        subprotocols=["shimpz.chat.v3"],
                        additional_headers=headers,
                    ) as websocket:
                        self.assertEqual(websocket.subprotocol, "shimpz.chat.v3")
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
        executor = self.chat_ws.BoundedThreadPoolExecutor(
            max_workers=1,
            max_outstanding=1,
            thread_name_prefix="chat-test",
        )
        release = threading.Event()
        future = executor.submit(release.wait)
        try:
            with self.assertRaises(self.chat_ws.ExecutorSaturatedError):
                executor.submit(lambda: None)
        finally:
            release.set()
            future.result(timeout=1)
            executor.shutdown()
