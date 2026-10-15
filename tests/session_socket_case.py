"""The base case of the Admin session socket tests (ADR-0114): an app with fresh session budgets per test."""

import importlib
from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

Socket = chat_socket_fixtures.Socket


class SessionSocketCase(ChatWebSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.session_socket = importlib.import_module("session.socket")
        self.registry = importlib.import_module("session.registry")
        self.topics = importlib.import_module("session.topics")
        self.budget = importlib.import_module("session.budget")
        self.calls = importlib.import_module("session.calls")
        self.methods = importlib.import_module("session.methods")
        self.lane = importlib.import_module("session.lane")
        # The real watcher's first samples would announce their topics to any test that subscribes to them; a test of
        # the watcher installs its own.
        watcher = importlib.import_module("session.watcher")
        quiet = mock.patch.object(watcher, "WATCHER", watcher.Watcher({}))
        quiet.start()
        self.addCleanup(quiet.stop)
        # Each test starts with fresh session budgets, so one test's opens and calls never spend another's.
        for name in ("OPENS", "CALL_BUDGET", "SOCKET_CHANGE_BUDGET"):
            patch = mock.patch.object(
                self.budget, name, type(getattr(self.budget, name))(getattr(self.budget, name)._limit)
            )
            patch.start()
            self.addCleanup(patch.stop)

    async def _connect(self, **options) -> Socket:
        websocket = Socket(self.admin_app.app, token=self.token, **options)
        self.assertTrue(self._accepted(await websocket.start()))
        return websocket

    @staticmethod
    async def _closed(websocket: Socket) -> int:
        """Read past the socket's frames to its close, returning the close code."""
        while (message := await websocket.next_message())["type"] != "websocket.close":
            pass
        return message["code"]

    @staticmethod
    def _refusal(code: int) -> dict:
        return {"type": "websocket.close", "code": code, "reason": ""}
